import * as THREE from 'three'

/**
 * The colour grade, as a procedurally generated 33^3 Data3DTexture (RGBA8).
 *
 * No .cube file — the grade is *computed* at load, which keeps the project's
 * "zero external assets" rule intact and, more usefully, means the grade is
 * readable and editable as numbers with reasons next to them instead of a
 * 36,000-line blob nobody can review.
 *
 * 33 is the standard authoring size (it is what Resolve, Baselight and every
 * .cube in the wild use) and it is chosen so that the exact midpoint 0.5 lands
 * on a lattice point (index 16 of 0..32) rather than being interpolated. Since
 * the S-curve pivots at 0.5, that matters.
 *
 * The transform is a real colourist chain, applied in DISPLAY-REFERRED space
 * (post tone map, post sRGB encode). Every offset below is in code values, so
 * feeding it linear light would turn a 0.006 toe into a hard linear floor and
 * paint a grey veil over the whole frame:
 *
 *   ASC-CDL slope/offset/power  ->  split tone  ->  luminance-preserving
 *   saturation  ->  highlight desaturation  ->  filmic S-curve pivoted at 0.50
 */

const SIZE = 33

// Rec.709 luminance weights, matching the shader side exactly.
const LUM_R = 0.2126
const LUM_G = 0.7152
const LUM_B = 0.0722

/**
 * SKYLINE COURIER — the grade.
 *
 * One grade, authored for one game: a sunny toybox of cream porcelain, aged
 * brass, moss green, terracotta and a restrained sky blue. Warm, bright,
 * gently filmic, maximum readability. Every value here errs toward bright and
 * warm; if you are ever unsure which way to nudge one, nudge it that way.
 */
export const GRADE = {
  // --- ASC CDL: out = (in * slope + offset) ^ power, per channel -----------
  //
  // A gentle warm bias in the transfer itself rather than in the tints, so it
  // affects the whole range instead of only the ends. Red gains 2%, blue loses
  // 1.5%: that is about 80K of warmth, enough to make cream read as cream
  // rather than as white, and small enough that the sky blue stays blue.
  slope: [1.020, 1.004, 0.985],
  // A hair of lift on all three so the darkest corner of a shadowed archway
  // has air in it. 0.003 is under one code value — this is not the toe, it is
  // just refusing to sit at absolute zero.
  offset: [0.003, 0.003, 0.004],
  // Power < 1 lifts the mid-tones. 0.97 on red and green is a visible brighten
  // of the mid greys; blue is left at 1.0 so lifting the mids does not also
  // wash the sky out.
  power: [0.970, 0.980, 1.000],

  // --- split tone ----------------------------------------------------------
  //
  // Cool-GREEN shadows, not cool-blue. Blue shadows are the teal-and-orange
  // reflex and they immediately make a bright game look like a thriller; a
  // green lean instead reads as bounced light off foliage and moss, which is
  // both warmer and consistent with what is actually in the level.
  // Weighted by (1 - L)^2.2, so it lives in the bottom third and is gone by
  // the mid-tones.
  shadowTint: [-0.006, 0.011, 0.006],
  // Warm cream highlights: red up, green up half as much, blue down. This is
  // the porcelain-in-sunlight signature and it is what keeps a blown highlight
  // from reading as a hole in the frame.
  // Weighted by L^2, so it is confined to the top third.
  highlightTint: [0.026, 0.014, -0.010],

  // --- saturation, about luminance ----------------------------------------
  //
  // Well above 1.0 on purpose. AgX's inset/outset pair is a DESATURATING
  // transform by construction — that is the whole reason it does not clip
  // saturated terracotta to neon — and the shoulder takes another bite out of
  // anything bright. 1.18 puts the chroma back where the palette was authored
  // without undoing the protection.
  saturation: 1.18,

  // --- contrast ------------------------------------------------------------
  //
  // A power about a pivot: out = pivot * (in/pivot)^contrast. 1.20 is a gentle
  // filmic firming, not a crush; this is a game where the player has to read a
  // runnable wall from 30 metres at speed.
  contrast: 1.20,
  //
  // THE PIVOT IS 0.50 AND MUST STAY THERE. It is the code value that does not
  // move under the contrast power, and AgX places 18% scene grey at ~0.50
  // display. Any other pivot is an exposure change wearing a contrast
  // costume: at 0.42 everything above a fairly dark mid-tone gets brighter and
  // you have silently added a third of a stop to the whole game.
  pivot: 0.50,

  // --- highlight desaturation ---------------------------------------------
  //
  // Film loses chroma in the shoulder. 0.10, weighted by L^3, is enough to
  // stop a sun-facing brass rail going neon and little enough that it does not
  // bleach the sky to grey. AgX has already done most of this work; piling
  // 0.25+ on top is how a sunset becomes a cream void.
  highlightDesat: 0.10,

  // --- toe -----------------------------------------------------------------
  //
  // Black lift in code values / 255. 0.006 is one and a half code values:
  // visible as "there is atmosphere down there", invisible as haze. A gentle
  // toe is right for this game — crushed blacks would make the shadowed parts
  // of the route unreadable, which is a gameplay bug, not a look.
  toe: 0.006,

  // --- shoulder ------------------------------------------------------------
  //
  // Knee, in post-contrast units. Above this the curve rolls off exponentially
  // instead of clipping flat, so cloud and specular separation survives the
  // last fifth of the range.
  shoulder: 0.62,
  // Softness, in the same units. The roll-off is NORMALISED (see
  // shoulderParams) so that input 1.0 maps to output 1.0 exactly. Without that
  // normalisation the curve asymptotes short of white and every bright surface
  // in the game piles up in a 30-code-value band — the classic "milky pastel
  // wash with no white in it" failure.
  shoulderSoft: 1.20,
}

/**
 * Derive the shoulder constants, including the normaliser that guarantees
 * scurve(1) === 1.
 */
function shoulderParams(g) {
  const k = Math.min(0.98, Math.max(0.05, g.shoulder))
  const s = Math.max(1e-3, g.shoulderSoft)
  // The largest post-contrast value an in-gamut input (1.0) can produce.
  const cMax = g.pivot * Math.pow(1 / g.pivot, g.contrast)
  const norm = 1 - Math.exp(-Math.max(cMax - k, 1e-3) / s)
  return { k, s, norm }
}

function applyGrade(r, g, b, P, sh) {
  // 1. ASC CDL
  r = Math.pow(Math.max(0, r * P.slope[0] + P.offset[0]), P.power[0])
  g = Math.pow(Math.max(0, g * P.slope[1] + P.offset[1]), P.power[1])
  b = Math.pow(Math.max(0, b * P.slope[2] + P.offset[2]), P.power[2])

  // 2. split tone, weighted by luminance
  const l1 = r * LUM_R + g * LUM_G + b * LUM_B
  // 2.2 / 2.0 exponents: shadow weight falls off slightly faster than highlight
  // weight rises, which leaves a clean neutral band across the mid-tones where
  // skin-equivalent surfaces (cream porcelain, here) are not tinted at all.
  const shadowW = Math.pow(1 - Math.min(1, l1), 2.2)
  const highW = Math.pow(Math.min(1, Math.max(0, l1)), 2.0)
  r += P.shadowTint[0] * shadowW + P.highlightTint[0] * highW
  g += P.shadowTint[1] * shadowW + P.highlightTint[1] * highW
  b += P.shadowTint[2] * shadowW + P.highlightTint[2] * highW

  // 3. saturation about luminance (luminance preserving by construction)
  const l2 = r * LUM_R + g * LUM_G + b * LUM_B
  r = l2 + (r - l2) * P.saturation
  g = l2 + (g - l2) * P.saturation
  b = l2 + (b - l2) * P.saturation

  // 4. highlight desaturation — pull toward luminance, weighted by L^3
  const hd = P.highlightDesat * Math.pow(Math.min(1, Math.max(0, l2)), 3.0)
  r += (l2 - r) * hd
  g += (l2 - g) * hd
  b += (l2 - b) * hd

  // 5. filmic S-curve, per channel
  return [scurve(r, P, sh), scurve(g, P, sh), scurve(b, P, sh)]
}

function scurve(x, P, sh) {
  const t = Math.max(0, x)
  // Contrast as a power about the pivot: the pivot itself never moves.
  let c = t <= 0 ? 0 : P.pivot * Math.pow(t / P.pivot, P.contrast)
  // Normalised exponential shoulder above the knee.
  if (c > sh.k) {
    c = sh.k + (1 - sh.k) * ((1 - Math.exp(-(c - sh.k) / sh.s)) / sh.norm)
  }
  // Toe last, as a lift of the whole range so it cannot push anything past 1.
  return P.toe + (1 - P.toe) * Math.min(1, Math.max(0, c))
}

/**
 * Build the 33^3 grade LUT.
 *
 * ~143k texels, evaluated once at construction; on any machine that can run
 * this game it is a couple of milliseconds and it never happens again.
 */
export function createGradeLut(grade = GRADE) {
  const sh = shoulderParams(grade)
  const n = SIZE
  const data = new Uint8Array(n * n * n * 4)
  let p = 0
  // z is the slowest axis and maps to blue: Data3DTexture layout is
  // x-major within a row, rows within a slice, slices along depth, which is
  // exactly the (r, g, b) ordering a .cube file uses.
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const out = applyGrade(x / (n - 1), y / (n - 1), z / (n - 1), grade, sh)
        data[p++] = Math.round(Math.min(1, Math.max(0, out[0])) * 255)
        data[p++] = Math.round(Math.min(1, Math.max(0, out[1])) * 255)
        data[p++] = Math.round(Math.min(1, Math.max(0, out[2])) * 255)
        data[p++] = 255
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, n, n, n)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  // Trilinear between lattice points. Nearest on a 33-step lattice is visible
  // as banding on any smooth gradient, and the sky is one big smooth gradient.
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  // Clamp on all three axes: the shader already scales into the texel-centre
  // range, and wrapping a grade LUT produces spectacular garbage at the ends.
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.wrapR = THREE.ClampToEdgeWrapping
  // RGBA8 rows are already 4-byte aligned, but 33 is odd and some drivers get
  // this wrong for 3D uploads; setting it explicitly costs nothing.
  texture.unpackAlignment = 1
  // The LUT holds code values, not linear light — no colour-space conversion
  // on sample.
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  texture.name = 'sc-grade-lut'

  return { texture, size: n }
}
