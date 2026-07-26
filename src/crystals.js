import * as THREE from 'three'
import {
  shardCluster, shard, SHARD_SCALE, boundsOf, triangleCount, FAR, MID, NEAR,
} from './props.js'
import { glowMaterial } from './materials.js'

/**
 * crystals.js — the void theme's light sources, as instanced geometry.
 *
 * `docs/art-direction-void.md` §4.3 asks for two families of jagged faceted
 * shard, and §7.3 makes instancing and LOD a REQUIREMENT rather than an
 * optimisation: "a dark scene full of emissives is the classic way to blow a
 * bloom budget". So the split of work is:
 *
 *   props.js  `shard` / `shardCluster`  — the geometry, flat facets, no colour
 *                                          policy, no collider, no material.
 *   this file                            — the material, the instanced field,
 *                                          and the LOD bucketing.
 *
 * THE DRAW-CALL ARITHMETIC, stated up front because it is the whole reason
 * this file exists. `CrystalField` builds one `InstancedMesh` per
 * (family, detail band, variant) bucket that is actually used. A level that
 * places hero clusters in two bands and scatter clusters in two bands, at the
 * default three variants, costs 12 draw calls for every crystal in the world —
 * against one per cluster if they were plain meshes, which for a few hundred
 * clusters is the budget gone. `stats()` reports the real number.
 *
 * WHY NOT THREE.LOD. `THREE.LOD` swaps per object per frame, which needs one
 * object per cluster and therefore one draw call per cluster: it is the exact
 * thing instancing is here to avoid. The kit's existing convention is a static
 * `detail: 0|1|2` chosen by the level from the distance band it is placing
 * into (see kit.js, "The level places these across four distance bands"), and
 * this follows it. The crystals do not move and neither does the course, so
 * the band is knowable at build time and a per-frame swap buys nothing.
 *
 * DETERMINISM: no `Math.random()` anywhere. Every variant and every instance
 * jitter comes from the seed.
 *
 * COLOUR IS ALWAYS A PARAMETER (§7.2 — "nothing gets a hardcoded violet").
 * There is not one colour literal in this file. The violet, blue and magenta of
 * the reference arrive from the caller, which gets them from the theme.
 */

const DEFAULT_SEED = 0x5C0117

function rng(seed = DEFAULT_SEED) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// -------------------------------------------------------- interior normals

/** Attribute name for the welded "interior" normal. Shared with the shader. */
export const INNER_NORMAL = 'scInnerNormal'

/**
 * Add a WELDED, SMOOTH normal alongside the flat facet normals.
 *
 * This is the one piece of data the translucency model needs and `props.shard`
 * cannot provide, and the reason is structural rather than an oversight. Every
 * facet there is emitted with its OWN vertices carrying its OWN plane normal —
 * that is what makes light snap between faces, and it is right. But it also
 * means every view-dependent quantity is CONSTANT ACROSS A FACET: `dot(N, V)`
 * has exactly one value per face, so any Fresnel or thickness term built on the
 * shading normal produces flat plates of brightness, not a glow. The first
 * thing that has to be true of an internally-lit crystal is that the light
 * varies WITHIN a face.
 *
 * Averaging the flat normals of every face that meets at a position recovers
 * the surface a smooth-shaded shard would have had: on the flanks it points
 * radially out from the shard's axis, at the tip it points along the axis. That
 * makes `dot(innerNormal, viewDir)` a continuous field that is ~1 where the
 * body is thickest along the view ray (the middle of the silhouette) and ~0 at
 * the silhouette itself. Which is the thickness of a convex body along the eye
 * ray, to within a constant — see `CRYSTAL_EMISSIVE` for what is done with it.
 *
 * WHY NOT `computeVertexNormals()` ON A WELDED CLONE: it would need
 * `mergeVertices` (three's BufferGeometryUtils, not a dependency here), a
 * second geometry, and a mapping back. This walks the positions once, costs one
 * pass and one Float32Array, and — critically — leaves the ORIGINAL normals
 * untouched, which is the whole point. Cost is paid once per bucket geometry at
 * build time (there are single digits of those, whatever the instance count),
 * never per frame and never per instance.
 *
 * Quantisation is 1e-4 m — a tenth of a millimetre, four orders of magnitude
 * under the smallest scatter shard's radius, so it can only ever weld vertices
 * that `props.shard` emitted from the same computed corner.
 */
export function addInnerNormals(geo) {
  const pos = geo.attributes.position
  const nrm = geo.attributes.normal
  if (!pos || !nrm || geo.getAttribute(INNER_NORMAL)) return geo
  const n = pos.count
  const sum = new Map()
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`
  for (let i = 0; i < n; i++) {
    const k = key(i)
    let a = sum.get(k)
    if (!a) { a = [0, 0, 0]; sum.set(k, a) }
    a[0] += nrm.getX(i); a[1] += nrm.getY(i); a[2] += nrm.getZ(i)
  }
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = sum.get(key(i))
    const l = Math.hypot(a[0], a[1], a[2])
    // A degenerate sum means the faces at this corner cancel exactly (a razor
    // edge). Falling back to the flat normal is the honest answer and keeps the
    // shader's normalize() out of NaN.
    if (l < 1e-6) { out[i * 3] = nrm.getX(i); out[i * 3 + 1] = nrm.getY(i); out[i * 3 + 2] = nrm.getZ(i) } else {
      out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l
    }
  }
  geo.setAttribute(INNER_NORMAL, new THREE.BufferAttribute(out, 3))
  return geo
}

// ---------------------------------------------------------------- material

/**
 * ============================ THE TRANSLUCENCY MODEL ========================
 *
 * Ethan, comparing the build to the reference image, 2026-07-25: the shards
 * rendered as "flat, opaque, pastel salmon-pink and pale-blue solids — they
 * read as coloured paper". The reference's crystals transmit light along their
 * length, have a near-white hot core inside a saturated violet body, and are
 * much more saturated than ours were. The geometry was never the problem.
 *
 * WHY THE OLD SHADING WENT PASTEL, measured rather than guessed. The old model
 * was one line — `totalEmissiveRadiance *= vColor` — which gives every fragment
 * of a shard `intensity * ramp * hue`. The void pins its exposure (theme.js:
 * `minEV = maxEV = -3.5`, `compensation = -1.18`), so the display transform
 * sees a fixed 4.17x multiplier, and the display transform is AgX
 * (`render/composite.js`), which by design "pushes chroma toward the centre" as
 * values climb. At intensity 1.35 the baked ramp put the shard body between
 * 0.5 and 5.1 in exposed linear — i.e. the WHOLE SHARD sat in the part of the
 * AgX curve whose job is to desaturate. A saturated red at (5.5, 0.14, 0.5)
 * comes out of AgX's inset matrix as pale salmon; a saturated violet comes out
 * pale lilac. Ethan was looking at the tone mapper, not at the crystals.
 *
 * So the fix is not "more brightness". It is putting the shard's VALUES back in
 * the places the reference has them:
 *
 *   BODY   ~0.35 exposed at the base rising to ~1.3 at the tip. Below the AgX
 *          desaturation knee, so it keeps its chroma, and below the bloom
 *          threshold (1.05, max-channel post-exposure) so it does not smear.
 *   CORE   6-8 exposed, over a small fraction of each shard. Above the bloom
 *          threshold by a lot, so it blooms and goes near-white — which is the
 *          reference's "hot core", and it is the ONE place white is wanted.
 *   RIM    ~1.7 exposed at the silhouette, fully saturated: a hard bright edge
 *          on a hard-edged object.
 *
 * §2's acceptance table asks for exactly this shape — p99 > 215 with only
 * 0.3-2.5% of the frame clipped, and sat > 0.45. A few small very bright
 * things, everything else saturated and dark.
 *
 * ---------------------------- WHICH TRANSLUCENCY ---------------------------
 *
 * Four options were on the table and the cheapest two are combined here.
 *
 *   (a) `MeshPhysicalMaterial.transmission` — REJECTED, and not on beauty. It
 *       forces three's transmission render pass (a full re-render of the opaque
 *       scene into a backbuffer per frame), moves the mesh into the transparent
 *       queue where it is depth-sorted per object, and `KHR_materials_*`
 *       transmission on an InstancedMesh sorts as ONE object however many
 *       instances it holds. That is a whole pass and correct sorting given up
 *       for 145 clusters. The file header's draw-call arithmetic is a
 *       requirement (§7.3), not a preference.
 *   (b) a per-vertex baked thickness — would need `props.shard` to emit the
 *       distance from its own axis, and that file is another lane's.
 *   (c) a Fresnel-weighted emissive rim — cheap, and included below as `rim`.
 *       Alone it is not translucency: it lights the edge and leaves the middle
 *       flat, which is the "coloured paper with a glowing border" failure.
 *   (d) a view-dependent path-length term — CHOSEN as the main event. For a
 *       convex body the distance a view ray travels inside it is longest where
 *       the surface faces the eye and zero at the silhouette, so `dot(N, V)` IS
 *       the thickness, up to a scale. Raised to a power it gives a soft core
 *       running down the middle of each shard that MOVES AS THE CAMERA MOVES —
 *       which is the thing that reads as "light inside glass" rather than as a
 *       painted highlight.
 *
 * (d) needs a normal that varies within a facet, which the flat facet normals
 * cannot give (see `addInnerNormals`). That welded normal is the entire cost of
 * this: one vec3 attribute, one varying, and about a dozen fragment ALU. No
 * extra pass, no extra draw call, no sorting, no transparency, no change to the
 * instancing.
 *
 * WHY THE HUE IS DIVIDED BACK OUT OF `vColor`. `vColor` arrives as
 * `bakedRamp * instanceColor` — three folds the vertex colour and the instanced
 * colour into one varying, which is what lets violet, blue and magenta clusters
 * share a bucket and a draw call. The ramp is baked NEUTRAL (grey), so dividing
 * vColor by it recovers the instance hue exactly, with no second attribute and
 * no second varying. Ramp and hue then drive different terms: the ramp is the
 * base-to-tip transmission, the hue is the colour, and the old model's mistake
 * was that it could only ever multiply them together.
 * ===========================================================================
 */
const CRYSTAL_PARS = /* glsl */`
varying vec3 vScInner;
varying float vScRamp;
`

const CRYSTAL_PARS_FRAGMENT = /* glsl */`
uniform vec4 uScBody;   // x base, y tip gain, z tip gamma, w chroma boost
uniform vec4 uScCore;   // x gain, y power, z base fraction, w mix to white
uniform vec4 uScRim;    // x gain, y power, z ramp base, w 1/(ramp tip - base)
`

/** Carries the neutral baked ramp through on its own, before the hue folds in. */
const CRYSTAL_RAMP_VERTEX = /* glsl */`
#ifdef USE_COLOR
  vScRamp = color.r;
#else
  vScRamp = 1.0;
#endif
`

/**
 * The welded normal, into view space, through the same instance transform three
 * just applied to the flat one.
 *
 * The instance matrices `CrystalField` writes are rotation times UNIFORM scale,
 * so `mat3(instanceMatrix)` is a similarity and normalising afterwards is the
 * whole of the inverse-transpose. Falling back to `objectNormal` when the
 * attribute is absent keeps a shard lit (flat, but lit) if this material is
 * ever put on geometry that never went through `addInnerNormals`.
 */
const CRYSTAL_INNER_VERTEX = /* glsl */`
vec3 scInner = ${INNER_NORMAL};
if ( dot( scInner, scInner ) < 1e-8 ) scInner = objectNormal;
#ifdef USE_INSTANCING
  scInner = mat3( instanceMatrix ) * scInner;
#endif
vScInner = normalMatrix * scInner;
`

/**
 * Body + core + rim, in place of the old `totalEmissiveRadiance *= vColor`.
 *
 * `totalEmissiveRadiance` is still `emissive * emissiveIntensity` at this point,
 * i.e. white times the field's `intensity`, so `intensity` remains the single
 * global dial the level turns and every term below is a RATIO against it. That
 * is what "make the material work across a range" means here: the level lane's
 * re-calibration from 3.2 to 1.35 stays valid, and the shape of the shard does
 * not change when the number does.
 */
const CRYSTAL_EMISSIVE = /* glsl */`
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  {
    // The baked ramp is neutral, so this is the instance hue, exactly.
    vec3 scHue = vColor.rgb / max( vScRamp, 1e-3 );

    // CHROMA PRE-COMPENSATION, and it has to be PER HUE.
    //
    // AgX desaturates on the way up, and its inset matrix mixes a few per cent
    // of every channel into every other one before the sigmoid. How much that
    // costs depends entirely on the hue: measured on this course, the sigil red
    // (#FF2D55, whose green and blue are already near zero) survived at full
    // chroma while the rune violet (#8B5CF6, whose green sits at 40% of its
    // blue) came back as pale lavender at the same brightness. A single global
    // saturation multiplier cannot serve both — at the setting the violet
    // needed, the red's green channel clamped at zero and the hue swung to
    // orange.
    //
    // So instead of a fixed multiplier this walks each hue toward ITS OWN most
    // saturated form: the point on the ray away from grey at which the first
    // channel reaches zero. That is the most chromatic colour of this hue there
    // is, it is well defined for every hue, and it can never overshoot into a
    // hue shift because it stops exactly at the boundary. uScBody.w is the
    // fraction of the way there, 0 = the theme colour untouched, 1 = fully
    // pure. The violet gets a 2.2x push and the red gets 1.1x, from one number.
    //
    // Renormalised to the ORIGINAL peak channel afterwards, because this is a
    // chroma move and must not double as an exposure move — the body/core
    // levels below are calibrated against AgX and would drift under every hue
    // differently if the peak floated.
    float scL = dot( scHue, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 scD = scHue - scL;
    float scMin = min( scD.r, min( scD.g, scD.b ) );
    float scK = scMin < -1e-4 ? scL / -scMin : 1.0;
    vec3 scPure = max( vec3( 0.0 ), scL + mix( 1.0, max( 1.0, scK ), uScBody.w ) * scD );
    float scPeak0 = max( scHue.r, max( scHue.g, scHue.b ) );
    float scPeak1 = max( scPure.r, max( scPure.g, scPure.b ) );
    scHue = scPure * ( scPeak0 / max( scPeak1, 1e-4 ) );

    // 0 at the base, 1 at the tip, with props.shard's per-facet value step
    // still in it — the step is what puts a value break on every arris, and
    // §4.3 wants that break more than it wants a clean gradient.
    float scT = clamp( ( vScRamp - uScRim.z ) * uScRim.w, 0.0, 1.0 );
    float scTip = pow( scT, uScBody.z );

    // Path length through the body along the view ray. See (d) above.
    vec3 scN = normalize( vScInner );
    vec3 scV = normalize( vViewPosition );
    float scFace = clamp( dot( scN, scV ), 0.0, 1.0 );

    float scBody = uScBody.x + uScBody.y * scTip;
    float scCoreW = uScCore.x * pow( scFace, uScCore.y )
                  * ( uScCore.z + ( 1.0 - uScCore.z ) * scTip );
    float scRimW = uScRim.x * pow( 1.0 - scFace, uScRim.y );

    totalEmissiveRadiance *= scHue * ( scBody + scRimW )
      // The core is the crystal's own hue walked toward white, not a white
      // light: a violet shard's core comes out near #EDE4FF and a blue one's
      // near its own analogue, so §3's core colour falls out of the theme
      // instead of being typed in. There is still not one colour literal here.
      + mix( scHue, vec3( 1.0 ), uScCore.w ) * scCoreW;
  }
#endif
`

/**
 * The base-to-tip ramp baked into the geometry's `color` attribute.
 *
 * HERE rather than in `FIELD_DEFAULTS` because the SHADER has to know the same
 * two numbers to undo the ramp — `CRYSTAL_EMISSIVE` remaps `[base, tip]` to
 * `[0, 1]` to recover the tip fraction. Two copies of a constant that must
 * agree is a bug waiting to happen, so there is one copy and both sides read it.
 *
 * THE RAMP TOPS OUT AT 0.78, NOT ABOVE 1, and this is unchanged and deliberate.
 * `vColor` multiplies the DIFFUSE term as well, and an albedo over 1 is a
 * surface that reflects more light than reaches it. An earlier version used a
 * 1.7 tip and every shard came back a clipped white spike with no facets in it.
 * Brightness above white is the EMISSIVE's job, where the bloom threshold can
 * see it — which is now what `GLOW_DEFAULTS.coreGain` is for. Facet variance
 * lifts this by up to 1.3x, so 0.78 keeps the peak albedo at ~1.0.
 */
const RAMP_BASE = 0.14
const RAMP_TIP = 0.78

/**
 * The translucency tuning, in units of `intensity`.
 *
 * CALIBRATED, NOT CHOSEN. The void pins its exposure, so there is a single
 * fixed number — 4.17x — between a scene-linear value here and what AgX sees
 * (theme.js: EV pinned at -3.5, compensation -1.18). With the level's
 * `intensity: 1.35` that makes one unit below worth 5.63 in exposed linear, and
 * every number here was picked against a target in THAT space and then checked
 * by rendering the course. The targets, and where they come from:
 *
 *   term            weight   x5.63 = exposed   why that number
 *   body @ base     0.032    0.18              AgX places 0.18 at mid display
 *                                              grey, which is where §3's
 *                                              #8B5CF6 actually lives — it is a
 *                                              MID-tone violet, not a bright one
 *   body @ tip      0.147    0.83              under the AgX desaturation knee
 *                                              and under the bloom threshold, so
 *                                              the body keeps its chroma and
 *                                              does not smear over its own core
 *   rim @ edge      0.30     1.69              just over bloom (1.05): a hot
 *                                              saturated edge that does bloom,
 *                                              but only a pixel or two wide
 *   core @ peak     6.0      33.8              far over bloom. This is the ONLY
 *                                              thing in the frame allowed to go
 *                                              white, and it is small
 *
 * THE BODY IS MUCH DARKER THAN THE FIRST ATTEMPT, and that is the correction
 * that actually landed it. Aiming the body at "bright" (1.3 exposed) still gave
 * pale lavender shards, because 1.3 is already inside AgX's desaturation. The
 * reference's body colour is a MID-TONE — #8B5CF6 is sRGB (139, 92, 246), which
 * is nothing like white — so the body belongs near mid grey and the shard gets
 * its LIGHT-SOURCE read from the core and the rim, not from a bright body. That
 * is also the difference between the two failure modes: a bright body is
 * coloured paper, a dark body with a hot core is glass.
 *
 * Measured on `node tools/shotset.mjs --theme void`, ascent (the shot with the
 * biggest crystals in frame), against §2's acceptance table:
 *
 *              lum    sat    p99    clip hi   clip lo   dyn
 *   before     34.4   0.835  206.4  2.87%     4.17%     205.2
 *   after      28.6   0.862  226.0  1.73%     4.12%     224.7
 *   §2 wants   28-55  >0.45  >215   0.3-2.5%  2-8%      >200
 *
 * — i.e. p99 and clip-hi moved from FAILING to passing, and nothing else left
 * its band. Draw calls and triangles are identical (73 / 961705) because none
 * of this is geometry.
 *
 * `intensity` still scales all four together, so the level lane's dial keeps
 * working; what these fix is the SHAPE, which is what was wrong. Change
 * `intensity` and the shard gets brighter or dimmer; change these and it
 * becomes a different material.
 */
const GLOW_DEFAULTS = {
  /** Emissive at the base of a shard. The dark end of the transmission. */
  bodyBase: 0.032,
  /** Added at the tip: §3, "they transmit light along their length". */
  bodyTip: 0.115,
  /**
   * 1.7. The ramp is already gamma-shaped in the geometry (`tipGamma: 2.4` on
   * the colour attribute) and this shapes it again in the emissive only — which
   * is the point: the DIFFUSE ramp should stay gentle (it is an albedo) while
   * the TRANSMITTED one is steep. Light going the length of a shard and out of
   * the point falls off far faster than paint does.
   */
  tipGamma: 1.7,
  /**
   * 0.85 of the way to the hue's own gamut boundary — see CRYSTAL_EMISSIVE for
   * what that means and why it is not a saturation multiplier. Measured: at 0
   * the rune violet comes back as pale lavender however dark the body is,
   * because AgX's inset lifts its green; at 1.0 every hue is exactly primary
   * and the three families start to look like the same three-colour set any
   * neon scene has. 0.85 keeps the violet reading violet rather than blue and
   * leaves the reds and blues visibly distinct from pure.
   */
  chroma: 0.85,
  /**
   * Peak of the view-dependent internal glow, facing the camera at the tip.
   *
   * WAS 6.0 (~34x display white). Calibrated against the shot set that is
   * correct, and against a PLAYER's frame it was not: at the ranges you
   * actually pass a hero cluster the core covered most of the silhouette,
   * bloomed over its own edges, and the shards read as white smears with no
   * facets — Ethan's screenshot beside the reference is unambiguous about it.
   * The reference's crystals are bright AND still legibly faceted.
   *
   * 2.6 is ~15x display white: still far over the 1.05 bloom threshold, so it
   * is still a light source and p99 still clears §2's 215, but the violet body
   * and the facet steps survive around it. The lesson worth keeping: a value
   * tuned on a distant shot is not tuned for the range the player meets it at.
   */
  coreGain: 2.6,
  /**
   * 26, up from 22 for the same reason as the gain above — a tighter core
   * leaves more of the shard reading as crystal rather than as glow.
   *
   * This is the WIDTH of the core and it is the most sensitive number in
   * the file. The exponent has to be this high because the welded normal on a
   * 4-7 sided prism turns slowly: measured on the course, `dot(N,V)^2.5` lit
   * most of the shard and read as "the whole thing is white", ^10 was still a
   * soft blob covering half the silhouette, and ^40 collapsed to a thin streak
   * that reads as a specular highlight ON the crystal rather than light INSIDE
   * it. 22 gives a core about a third of the silhouette wide with a soft
   * shoulder, which is what the reference has.
   */
  corePower: 26.0,
  /**
   * 0.16. How much core survives at the BASE of a shard, where the light has
   * travelled furthest. Not zero, because a shard whose lower half has no
   * interior at all reads as two materials joined at the waist.
   */
  coreBase: 0.16,
  /**
   * 0.78 of the way to white. §3 wants "a near-white #EDE4FF core"; the theme's
   * violet walked most of the way to white lands there, and the same mix gives
   * the blue and magenta families their own analogue instead of a shared white.
   * Note this is the colour BEFORE `coreGain`, which then drives it far past
   * display white — the core is meant to blow out.
   */
  coreWhite: 0.78,
  /** Silhouette edge, fully saturated. Fresnel's cheap half of translucency. */
  rimGain: 0.30,
  /**
   * 3.5 — a tight edge. The rim is here to draw the ARRIS, not to halo the
   * shard; a low power turns it into a soft glow that fights the core for the
   * middle of the silhouette and washes both out. Measured: rimGain past ~0.45
   * puts the whole periphery over AgX's knee and the shard grows a pale border,
   * which was one of the two things that read as "coloured paper".
   */
  rimPower: 3.5,
}

/**
 * `crystalMaterial(color, opts)` — the emissive treatment for shards.
 *
 * DOES `materials.glowMaterial` SUIT? Partly, and it is reused rather than
 * reimplemented — the shared shape (MeshStandardMaterial, `emissive` set to the
 * same colour as `color`, standard lighting so the flat facets still catch the
 * scene's rim lights) is exactly right. Three deltas were needed and each one
 * is a shard-specific requirement, not a difference of opinion:
 *
 *   1. glowMaterial leaves `vertexColors` OFF, because it is built for the
 *      lantern globes, which are one solid colour. A shard's whole read is a
 *      colour that changes along its length AND from facet to facet — and on
 *      an emissive object that variation is the only thing standing in for the
 *      normal break, because emissive has no normal term. See
 *      CRYSTAL_EMISSIVE and `props.shard`'s `facetVariance`.
 *   2. `roughness: 0.4, metalness: 0.1` is a soft plastic. A crystal facet
 *      wants a tight, hard specular lobe so the light SNAPS between faces as
 *      the camera moves (§4.3) — that is roughness ~0.18 and no metalness.
 *   3. Default intensity 1.4 is under the bloom threshold once exposed. The
 *      pipeline thresholds bloom on the MAX CHANNEL post-exposure, so a
 *      saturated violet blooms when its BLUE channel clips while its green sits
 *      dark — which is why values above 1.0 are correct rather than a mistake.
 *      A crystal that does not bloom is not a light source, and §2's acceptance
 *      table wants p99 > 215 with only 0.3-2.5% of the frame clipped: a few
 *      small very bright things.
 *   4. The whole translucency model above — body, core and rim, keyed off the
 *      welded interior normal. See THE TRANSLUCENCY MODEL.
 *
 * NOT OPTED OUT OF THE AERIAL-PERSPECTIVE PATCH, on purpose. `render/patch.js`
 * offers `material.userData.scNoPatch`, and the tempting argument is that a
 * light source should not be fogged. It is wrong here: §5 asks for "depth in
 * three bands ... far structures washed almost to the fog colour", and the
 * crystals are the only thing in a near-black frame with enough energy to show
 * that wash at all. The patch replaces `fog_fragment`, which runs after the
 * emissive is added, so a distant shard correctly loses contrast into the
 * violet haze while a near one does not. Opting out would flatten every
 * distance band onto one.
 *
 * @param {number|THREE.Color} color   the crystal's own colour (theme data)
 * @param {object} [opts] `{ intensity, roughness, envMapIntensity, name }` plus
 *   the GLOW tuning in `GLOW_DEFAULTS`. The tuning is uniforms, not baked
 *   constants, so every crystal material in the process shares ONE compiled
 *   program however many intensities the level asks for — and so a live tuner
 *   can reach `mat.userData.scGlow` and move them without a recompile.
 */
export function crystalMaterial(color, opts = {}) {
  const intensity = opts.intensity ?? 3.2
  const mat = glowMaterial(color, intensity)
  mat.vertexColors = true
  mat.roughness = opts.roughness ?? 0.18
  mat.metalness = 0
  /**
   * DARK ALBEDO, BRIGHT EMISSIVE — the fourth delta from `glowMaterial`, and
   * the one that decides whether these read as crystals or as plaster cones.
   *
   * `vColor` multiplies the diffuse term and the emissive term together, so the
   * ratio between them is set here and nowhere else. glowMaterial leaves
   * `color` equal to `emissive`, which for a lantern globe is fine. On a shard
   * it means the scene's own lights land on a near-white surface and add a pale
   * unsaturated wash on top of the glow — measured, that wash was most of why
   * the first render came back lilac instead of violet. A real crystal reflects
   * very little and emits a lot. 0.16 keeps just enough diffuse for a nearby
   * red sigil or another crystal to tint a facet, and no more.
   */
  mat.color.setScalar(opts.albedo ?? 0.16)
  // Facets are already flat (props.shard gives every face its own normals), so
  // `flatShading` would only cost a second normal computation for no change.
  mat.flatShading = false
  if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity
  mat.name = opts.name || 'crystal'

  const g = { ...GLOW_DEFAULTS, ...(opts.glow || {}) }
  const rampBase = opts.rampBase ?? RAMP_BASE
  const rampTip = opts.rampTip ?? RAMP_TIP
  const uniforms = {
    uScBody: { value: new THREE.Vector4(g.bodyBase, g.bodyTip, g.tipGamma, g.chroma) },
    uScCore: { value: new THREE.Vector4(g.coreGain, g.corePower, g.coreBase, g.coreWhite) },
    uScRim: {
      value: new THREE.Vector4(g.rimGain, g.rimPower, rampBase,
        1 / Math.max(1e-3, rampTip - rampBase)),
    },
  }
  mat.userData.scGlow = uniforms

  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\n${CRYSTAL_PARS}\nattribute vec3 ${INNER_NORMAL};\n`)
      // `color_vertex` is where the neutral ramp is still separable from the
      // instance hue; one line later they are multiplied together forever.
      .replace('#include <color_vertex>',
        '#include <color_vertex>\n' + CRYSTAL_RAMP_VERTEX)
      // `defaultnormal_vertex` is the first point at which `objectNormal` and
      // `normalMatrix` are both live, and it is exactly where three does the
      // same transform to the flat normal — so the two stay in one space by
      // construction rather than by hope.
      .replace('#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\n' + CRYSTAL_INNER_VERTEX)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CRYSTAL_PARS}${CRYSTAL_PARS_FRAGMENT}`)
      // `normal_fragment_begin` runs before this, so `normal` and
      // `vViewPosition` are both available where the model needs them.
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n' + CRYSTAL_EMISSIVE)
  }
  // Distinct cache key or three hands this material the unpatched program it
  // compiled for some other MeshStandardMaterial. `render/patch.js` appends to
  // whatever it finds here rather than replacing it, so the two compose.
  //
  // The key does NOT include the tuning: every number above is a uniform, so
  // two differently-tuned crystal materials are the same program and should
  // share it.
  mat.customProgramCacheKey = () => 'sc-crystal-translucent-1'
  return mat
}

// ------------------------------------------------------------------- field

const FIELD_DEFAULTS = {
  seed: DEFAULT_SEED,
  /** Distinct cluster geometries per (family, detail) bucket. */
  variants: 3,
  /** Emissive multiplier handed to `crystalMaterial`. */
  intensity: 3.2,
  /**
   * Crystals neither cast nor receive shadows.
   *
   * They are the light in this world (§1, "lit entirely from within"), and a
   * self-shadowing light source reads as a dirty one. It is also free
   * performance: the shadow pass is the second-most expensive thing in the
   * frame and a hundred instanced clusters would double its cost to darken
   * geometry that is already emissive.
   */
  castShadow: false,
  receiveShadow: false,
}

/**
 * `CrystalField` — every crystal in a level, in a handful of draw calls.
 *
 * Usage:
 *   const field = new CrystalField({ seed, intensity: 2.6 })
 *   field.add('hero', x, y, z, { color: theme.crystal.violet, detail: NEAR })
 *   field.add('scatter', x, y, z, { color: theme.crystal.blue, detail: MID, size: 0.8 })
 *   scene.add(field.build())
 *
 * COLLISION: this creates none, ever, and cannot — same contract as props.js.
 * §6 says crystals are never a hazard, so the normal case is that they need no
 * collider at all. A hero cluster big enough to stand on is the caller's
 * problem to declare with `L.solid(..., { hidden: true })`, sized from
 * `field.clusterBounds(family, detail, variant)`, which reports the MEASURED
 * box of the geometry an instance will draw. Multiply it by the instance's
 * `size` and rotate it by the instance's `yaw` and that is the real footprint —
 * the number is measured, not guessed, exactly as `boundsOf()` intends.
 */
export class CrystalField {
  constructor(opts = {}) {
    this.options = { ...FIELD_DEFAULTS, ...opts }
    this.rand = rng(this.options.seed)
    this._buckets = new Map()      // key -> { family, detail, variant, geo, rows[] }
    this._materials = new Map()    // intensity-keyed; colour rides on instanceColor
    this._group = null
    this._meshes = []
    this._built = false
  }

  get count() {
    let n = 0
    for (const b of this._buckets.values()) n += b.rows.length
    return n
  }

  /** Build (and cache) one cluster geometry. Deterministic in (family, detail, variant). */
  _geometry(family, detail, variant) {
    const key = `${family}|${detail}|${variant}`
    let bucket = this._buckets.get(key)
    if (bucket) return bucket
    const o = this.options
    // The variant seed must not depend on placement order, or adding one
    // crystal in the middle of a level would reshuffle every other one.
    const seed = (o.seed ^ (0x9E3779B1 * (variant + 1)) ^ (family === 'hero' ? 0x11 : 0x77)
      ^ (detail * 0x2545F491)) | 0
    // Colour is baked as a NEUTRAL base-to-tip ramp and the actual hue arrives
    // per instance through `instanceColor`. That is what lets violet, blue and
    // magenta clusters share one bucket and one draw call — see
    // CRYSTAL_EMISSIVE, which divides the ramp back out to get the hue on its
    // own. The ramp levels live in RAMP_BASE / RAMP_TIP because the shader
    // needs the same two numbers to undo it.
    const lo = o.rampBase ?? RAMP_BASE
    const hi = o.rampTip ?? RAMP_TIP
    const geo = shardCluster(seed, {
      scale: family,
      detail,
      color: [lo, lo, lo],
      tipColor: [hi, hi, hi],
      tipGamma: o.tipGamma ?? 2.4,
    })
    // The welded interior normal the translucency model runs on. Once per
    // bucket geometry — single digits of these per level, whatever the instance
    // count — and never per frame. See `addInnerNormals`.
    addInnerNormals(geo)
    bucket = { key, family, detail, variant, geo, bounds: boundsOf(geo), rows: [] }
    this._buckets.set(key, bucket)
    return bucket
  }

  /** Measured bounds of the geometry one instance of this bucket draws. */
  clusterBounds(family, detail = NEAR, variant = 0) {
    return this._geometry(family, detail, variant).bounds
  }

  /**
   * Place one cluster.
   *
   * @param {'hero'|'scatter'} family
   * @param {number} x world X
   * @param {number} y world Y — where the cluster's bases sit (they sink a
   *                  little below this, so it can be put ON a surface)
   * @param {number} z world Z
   * @param {object} [opts]
   *   color    the crystal's colour. THIS IS THE ONLY PLACE COLOUR ENTERS.
   *   detail   FAR | MID | NEAR (default NEAR for hero, MID for scatter)
   *   size     uniform metre scale on the preset (default 1)
   *   yaw      rotation about Y (default seeded)
   *   tilt / tiltAzimuth  lean the whole cluster off vertical, so a cluster can
   *            hang off a platform underside or grow out of a wall (§4.3)
   *   variant  pin the shape instead of drawing one
   *   gain     per-instance brightness multiplier on `color` (default 1)
   */
  add(family, x, y, z, opts = {}) {
    if (this._built) throw new Error('CrystalField: add() after build()')
    if (family !== 'hero' && family !== 'scatter') {
      throw new Error(`CrystalField: unknown family ${family}`)
    }
    const rand = this.rand
    const detail = opts.detail ?? (family === 'hero' ? NEAR : MID)
    const variants = Math.max(1, this.options.variants | 0)
    const variant = opts.variant !== undefined
      ? clamp(opts.variant | 0, 0, variants - 1)
      : (rand() * variants) | 0
    const bucket = this._geometry(family, detail, variant)

    const size = opts.size ?? 1
    const yaw = opts.yaw ?? rand() * Math.PI * 2
    const tilt = opts.tilt ?? 0
    const tiltAz = opts.tiltAzimuth ?? rand() * Math.PI * 2

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    if (Math.abs(tilt) > 1e-6) {
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(Math.sin(tiltAz), 0, -Math.cos(tiltAz)).normalize(), tilt))
    }
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), q, new THREE.Vector3(size, size, size))

    const c = new THREE.Color(opts.color ?? 0xffffff)
    const gain = opts.gain ?? 1
    bucket.rows.push({ m, c: [c.r * gain, c.g * gain, c.b * gain] })
    return this
  }

  /** Shared material per intensity. Colour rides on `instanceColor`. */
  _material(intensity) {
    const key = String(intensity)
    let mat = this._materials.get(key)
    if (!mat) {
      // White base colour: the hue is entirely per instance, so a white
      // material times instanceColor is the crystal's colour and nothing here
      // has an opinion about what that is.
      mat = crystalMaterial(0xffffff, {
        intensity,
        name: `crystal-${key}`,
        // The shader has to undo exactly the ramp the geometry was baked with,
        // so the field hands its own values across rather than letting the two
        // default independently.
        rampBase: this.options.rampBase ?? RAMP_BASE,
        rampTip: this.options.rampTip ?? RAMP_TIP,
        glow: this.options.glow,
      })
      this._materials.set(key, mat)
    }
    return mat
  }

  /** Build the meshes. Idempotent; returns the group either way. */
  build() {
    if (this._built) return this._group
    this._built = true
    this._group = new THREE.Group()
    this._group.name = 'crystals'
    const mat = this._material(this.options.intensity)

    for (const b of this._buckets.values()) {
      const n = b.rows.length
      if (n === 0) { b.geo.dispose(); continue }
      const mesh = new THREE.InstancedMesh(b.geo, mat, n)
      mesh.name = `crystals-${b.family}-d${b.detail}-v${b.variant}`
      const colours = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, b.rows[i].m)
        colours[i * 3] = b.rows[i].c[0]
        colours[i * 3 + 1] = b.rows[i].c[1]
        colours[i * 3 + 2] = b.rows[i].c[2]
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3)
      mesh.castShadow = this.options.castShadow
      mesh.receiveShadow = this.options.receiveShadow
      // Derived from the geometry box and every instance matrix, so per-bucket
      // frustum culling means something instead of being all-or-nothing over
      // the whole level.
      mesh.computeBoundingSphere()
      this._group.add(mesh)
      this._meshes.push(mesh)
    }
    return this._group
  }

  /**
   * Suggested point-light positions, brightest clusters first.
   *
   * The crystals are geometry: they GLOW, they do not LIGHT. Making the rock
   * around them actually respond needs real lights, and the number of those is
   * a frame-budget decision that belongs to whoever owns the level, not to this
   * file. So this reports where a light would do the most good — the top of the
   * `n` largest clusters, in world space, with the colour and a radius taken
   * from the cluster's measured height — and places none itself.
   */
  emitters(max = 8) {
    const out = []
    const v = new THREE.Vector3()
    for (const b of this._buckets.values()) {
      for (const row of b.rows) {
        const scale = v.setFromMatrixColumn(row.m, 0).length()
        const h = b.bounds.max[1] * scale
        const p = new THREE.Vector3().setFromMatrixPosition(row.m)
        out.push({
          position: [p.x, p.y + h * 0.72, p.z],
          color: row.c,
          radius: Math.max(3, h * 2.2),
          weight: h,
        })
      }
    }
    out.sort((a, b) => b.weight - a.weight)
    return out.slice(0, Math.max(0, max))
  }

  /** Draw calls, instances and triangles, per bucket and in total. */
  stats() {
    const buckets = []
    let instances = 0, triangles = 0, drawn = 0
    for (const b of this._buckets.values()) {
      const tris = triangleCount(b.geo)
      if (b.rows.length > 0) drawn++
      instances += b.rows.length
      triangles += tris * b.rows.length
      buckets.push({
        key: b.key,
        family: b.family,
        detail: b.detail,
        variant: b.variant,
        instances: b.rows.length,
        trianglesPerInstance: tris,
        size: b.bounds.size.map((n) => Math.round(n * 1000) / 1000),
      })
    }
    buckets.sort((a, b) => (a.key < b.key ? -1 : 1))
    return { drawCalls: drawn, buckets, instances, triangles }
  }

  dispose() {
    for (const b of this._buckets.values()) b.geo.dispose()
    for (const m of this._materials.values()) m.dispose()
    this._buckets.clear()
    this._materials.clear()
    this._meshes = []
  }
}

// ---------------------------------------------------------------- self test

/**
 * `crystalsSelfTest()` — the LOD table, and the numbers §7.3 asks to be kept.
 *
 * `node src/crystals.js` prints it. It builds no material (there is no WebGL
 * context under node) and no field mesh; what it measures is the thing that
 * actually costs: triangles per cluster per detail band, and the draw-call
 * arithmetic of a realistic placement.
 */
export function crystalsSelfTest() {
  const rows = []
  for (const family of ['hero', 'scatter']) {
    for (const detail of [FAR, MID, NEAR]) {
      // Averaged over the default variant count: one variant's count depends on
      // how many shards its seed drew, and a single sample would report noise.
      let tris = 0, verts = 0
      const V = 3
      const sizes = []
      for (let v = 0; v < V; v++) {
        const geo = shardCluster((0x5C0117 ^ (0x9E3779B1 * (v + 1))) | 0, { scale: family, detail })
        tris += triangleCount(geo)
        verts += geo.attributes.position.count
        sizes.push(boundsOf(geo).size.map((n) => Math.round(n * 100) / 100))
        geo.dispose()
      }
      rows.push({
        family,
        detail,
        band: detail === FAR ? 'FAR' : detail === MID ? 'MID' : 'NEAR',
        triangles: Math.round(tris / V),
        vertices: Math.round(verts / V),
        sizes,
      })
    }
  }

  // A single shard at each band, for the per-primitive number.
  const single = [FAR, MID, NEAR].map((detail) => ({
    band: detail === FAR ? 'FAR' : detail === MID ? 'MID' : 'NEAR',
    triangles: (() => {
      const g = shard(0xC0FFEE, { length: 9, radius: 1.05, facets: 6, detail })
      const t = triangleCount(g)
      g.dispose()
      return t
    })(),
  }))

  // A realistic placement, to make the draw-call claim in this file's header
  // checkable rather than asserted.
  const field = new CrystalField({ seed: 0x5C0117 })
  const r = rng(0xBEEF)
  for (let i = 0; i < 40; i++) {
    field.add('hero', r() * 200, r() * 60, r() * 200, {
      detail: i < 12 ? NEAR : MID, color: 0x8b5cf6, size: 0.7 + r(),
    })
  }
  for (let i = 0; i < 260; i++) {
    field.add('scatter', r() * 200, r() * 60, r() * 200, {
      detail: i < 90 ? MID : FAR, color: i % 3 === 0 ? 0x3b82f6 : 0x8b5cf6,
    })
  }
  const stats = field.stats()

  const problems = []
  for (const row of rows) {
    if (row.triangles <= 0) problems.push(`${row.family}/${row.band}: no triangles`)
  }
  for (let i = 1; i < single.length; i++) {
    if (single[i].triangles < single[i - 1].triangles) {
      problems.push('single shard: triangle count does not rise with detail')
    }
  }
  if (stats.drawCalls > 18) problems.push(`draw calls ${stats.drawCalls} — instancing is not doing its job`)

  // The translucency model is silently wrong without this attribute — the
  // shader falls back to the flat normal, which is the flat-plate look the
  // whole thing exists to fix, and nothing else would notice. So: check it.
  let innerChecked = 0
  for (const b of field._buckets.values()) {
    const a = b.geo.getAttribute(INNER_NORMAL)
    if (!a) { problems.push(`${b.key}: no ${INNER_NORMAL}`); continue }
    if (a.count !== b.geo.attributes.position.count) {
      problems.push(`${b.key}: ${INNER_NORMAL} is ${a.count} of ${b.geo.attributes.position.count}`)
      continue
    }
    let worst = 0
    for (let i = 0; i < a.count; i++) {
      const l = Math.hypot(a.getX(i), a.getY(i), a.getZ(i))
      worst = Math.max(worst, Math.abs(l - 1))
    }
    if (worst > 1e-3) problems.push(`${b.key}: ${INNER_NORMAL} not unit (off by ${worst.toFixed(4)})`)
    innerChecked++
  }

  // The welded normal must actually DIFFER from the flat one, or it is a
  // rename of the thing it replaces and every view-dependent term goes back to
  // being constant per facet. Measured on one hero cluster.
  const probe = field._buckets.values().next().value
  let maxDev = 0
  if (probe) {
    const inner = probe.geo.getAttribute(INNER_NORMAL)
    const flat = probe.geo.attributes.normal
    for (let i = 0; i < flat.count; i++) {
      const d = inner.getX(i) * flat.getX(i) + inner.getY(i) * flat.getY(i) + inner.getZ(i) * flat.getZ(i)
      maxDev = Math.max(maxDev, 1 - d)
    }
    if (maxDev < 0.02) problems.push('inner normals are the flat normals — no interior to shade')
  }
  field.dispose()

  return { rows, single, stats, problems, innerChecked, maxDev, ok: problems.length === 0 }
}

// Guarded on `process` so the browser bundle never touches it, and importing no
// node modules so vite has nothing to externalise. Same pattern as props.js.
if (typeof process !== 'undefined' && Array.isArray(process.argv) &&
    typeof process.argv[1] === 'string' && /crystals\.js$/.test(process.argv[1])) {
  const t = crystalsSelfTest()
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('single shard', 16), pad('tris', 8))
  for (const s of t.single) console.log(pad('  ' + s.band, 16), pad(s.triangles, 8))
  console.log('')
  console.log(pad('cluster', 16), pad('band', 8), pad('tris', 8), pad('verts', 8), 'sizes (m)')
  for (const r of t.rows) {
    console.log(pad('  ' + r.family, 16), pad(r.band, 8), pad(r.triangles, 8), pad(r.vertices, 8),
      JSON.stringify(r.sizes))
  }
  console.log('')
  console.log(pad('bucket', 26), pad('instances', 11), 'tris/instance')
  for (const b of t.stats.buckets) console.log(pad('  ' + b.key, 26), pad(b.instances, 11), b.trianglesPerInstance)
  console.log('')
  console.log(`inner normals: ${t.innerChecked} buckets unit-length, max deviation from`
    + ` the flat normal ${(t.maxDev * 100).toFixed(1)}%`)
  console.log('\n300 clusters ->', t.stats.drawCalls, 'draw calls,',
    t.stats.instances, 'instances,', t.stats.triangles, 'triangles')
  console.log('problems:', t.problems.length ? '\n  ' + t.problems.join('\n  ') : 'none')
}
