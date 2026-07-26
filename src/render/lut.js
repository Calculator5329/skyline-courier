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
 *   saturation  ->  highlight desaturation  ->  gamut guard  ->  filmic
 *   S-curve pivoted at 0.50, with a shoulder and a real toe
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
  // affects the whole range instead of only the ends. Red gains 2.4%, blue loses
  // 1.8%: that is about 100K of warmth, enough to make cream read as cream
  // rather than as white, and small enough that the sky blue stays blue.
  slope: [1.024, 1.005, 0.982],
  // A hair of lift, and cooler than it is warm, so the darkest corner of a
  // shadowed archway has air in it and that air is on the cool side of the
  // warm/cool split. Under one code value each — this is not the toe, it is
  // just refusing to sit at absolute zero.
  offset: [0.001, 0.002, 0.003],
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
  // Weighted by (1 - L)^SHADOW_FALLOFF, so it lives in the bottom third and is
  // faded out by the mid-tones.
  //
  // AN ORDER OF MAGNITUDE UP from [-0.006, 0.011, 0.006]. That was 1.5 code
  // values out of 255 — an intent expressed in a comment and delivered as
  // nothing. Measured on the shot set, lit-versus-shadow hue on the same
  // sandstone deck came back at 31.4 -> 27.0 degrees: shadows going WARMER,
  // which is the exact inverse of the brief.
  //
  // [-0.026, 0.034, 0.015] is 7-9 code values, which is visible, and it is
  // skewed GREEN-of-cyan (g > b, r negative) rather than neutral-cool: blue
  // shadows are the teal-and-orange reflex and instantly read as a thriller,
  // while a green lean reads as bounced light off the moss and cypress that are
  // actually in this level.
  //
  // This is the SECOND half of the fix and deliberately the smaller one. The
  // grade cannot tell a shadow from a dark surface, so a big number here
  // olive-tints every dark texture crevice in the frame as well. The lighting
  // does the real work: see the zenith/aureole rebalance in skyenv.js and the
  // orientation-driven split in patch.js, both of which only touch surfaces
  // that are genuinely receiving ambient rather than key.
  //
  // CUT TO +0.018 GREEN, from +0.034. That paragraph above turned out to be a
  // warning this file did not take seriously enough: at 0.034, amplified by a
  // saturation of 1.30, the grade was greening every dark texel in the frame
  // whether it was in shadow or not — and the frame's darkest large surface is
  // the deck, because a sun at 9.8 degrees of elevation delivers sin(9.8) =
  // 0.17 of its key to anything horizontal. The result is the value inversion
  // the art review filed against tower.png: bright sandstone risers over
  // olive-green treads, on a stair the player has to read at speed.
  //
  // The separation the big number was buying is now carried where it belongs,
  // by `scAmbientTint` in patch.js, which can see the surface ORIENTATION and
  // therefore knows the difference between a wall in shadow (green, correctly)
  // and a deck that is merely receiving a low sun (not green).
  shadowTint: [-0.018, 0.018, 0.010],
  // Warm cream highlights: red up, green up half as much, blue down. This is
  // the porcelain-in-sunlight signature and it is what keeps a blown highlight
  // from reading as a hole in the frame.
  // Weighted by L^2, so it is confined to the top third.
  highlightTint: [0.026, 0.014, -0.010],

  // --- split-tone falloff exponents ----------------------------------------
  //
  // Shadow weight is (1 - L)^shadowFalloff, highlight weight is L^highlightRise.
  //
  // shadowFalloff 1.85, down from a hard-coded 2.2. At 2.2 the tint is at half
  // strength by L = 0.34 and effectively gone by 0.5, so it only ever coloured
  // the toe — and the shadows in this game are not in the toe, they are in the
  // lower mid-tones (measured p1 across the set: 22-50 out of 255, p50 around
  // 115). 1.85 pushes the half-strength point up to L = 0.42 so the tint
  // reaches the values a cast shadow on sunlit sandstone actually lands at,
  // and stops short of 1.7, which reached far enough up to olive-tint the
  // SUNLIT deck as well.
  shadowFalloff: 1.85,
  // Unchanged at 2.0: the highlight tint is doing its job and reaching further
  // down would put warm cream into the mid-tones, which is where the cool half
  // of the split needs to live.
  highlightRise: 2.0,

  // --- saturation, about luminance ----------------------------------------
  //
  // Well above 1.0 on purpose. AgX's inset/outset pair is a DESATURATING
  // transform by construction — that is the whole reason it does not clip
  // saturated terracotta to neon — and the shoulder takes another bite out of
  // anything bright. 1.30 puts the chroma back where the palette was authored
  // without undoing the protection. It went up from 1.22 when the metering fix
  // raised the average exposure: a brighter frame sits further up the AgX
  // shoulder, which desaturates harder, and the whole set measured 0.31-0.64
  // against a 0.34-0.69 baseline until this compensated for it.
  //
  // It stops there rather than going higher because the DISTANCE-dependent half
  // of the restore belongs in patch.js, where it can be keyed on how much haze
  // the ray actually crossed. Pushing this number far enough to rescue the far
  // archipelago would over-saturate the foreground, which measured 0.51-0.69
  // and was never the problem.
  saturation: 1.30,

  // --- contrast ------------------------------------------------------------
  //
  // A power about a pivot: out = pivot * (in/pivot)^contrast.
  //
  // 1.32, up from 1.20. The baseline critique was that the whole game lived in
  // the mid-tones: measured, the 1st percentile across the shot set ranged
  // 43.7-73.3 and the 99th 155.5-185.3, with nothing clipped at either end.
  // The white point below fixed the top; this fixes the bottom, because a
  // contrast power about a 0.5 pivot is the only control in the chain that
  // pushes dark values DOWN without also lifting a veil over the mids.
  // Still gentle — this is a game where the player has to read a runnable wall
  // from 30 metres at speed, and a crush there is a gameplay bug.
  contrast: 1.32,
  //
  // THE PIVOT IS 0.50 AND MUST STAY THERE. It is the code value that does not
  // move under the contrast power, and AgX places 18% scene grey at ~0.50
  // display. Any other pivot is an exposure change wearing a contrast
  // costume: at 0.42 everything above a fairly dark mid-tone gets brighter and
  // you have silently added a third of a stop to the whole game.
  pivot: 0.50,

  // --- highlight desaturation ---------------------------------------------
  //
  // Film loses chroma in the shoulder. 0.06, down from 0.10: AgX's inset is
  // already a desaturating transform and the two together were over-doing it —
  // the vista frame measured 0.34 mean saturation and no frame in the set
  // exceeded 0.70. Weighted by L^3 this still catches a sun-facing brass rail
  // before it goes neon, which is the only thing it was ever needed for, while
  // letting sunlit sandstone keep its ochre on the way to white.
  highlightDesat: 0.06,

  // --- gamut guard ---------------------------------------------------------
  //
  // THE FIX FOR underpass.png's CLIPPING, and it is not where anyone looked.
  //
  // That shot measured 2.75% clipped high and dropping the brass glint from
  // 1.5 to 1.15 did not move the number by a hundredth. Measured properly —
  // histogramming the colour of every clipped pixel rather than assuming —
  // 24,372 of its 39,582 clipped pixels come back as (255, ~104, ~50). That is
  // not brass and it is not the sky. It is TERRACOTTA with its red channel
  // clipped and its other two nowhere near, and the clip happens here.
  //
  // `highlightDesat` above cannot catch it, by construction: it is weighted by
  // L^3, and a saturated red has a LUMINANCE of about 0.4 while its red channel
  // is over 1.0. Rec.709 weights red at 0.2126, so a channel can run a third of
  // a stop past white while the luminance-keyed guard sees a mid-tone and does
  // nothing at all. `saturation: 1.30` then pushes it further out (0.70 -> 0.79
  // on the measured value) and `contrast: 1.32` about a 0.5 pivot expands
  // everything above the pivot again.
  //
  // So the guard is keyed on the MAX CHANNEL, which is the quantity that
  // actually clips. Above the knee it pulls the colour toward its own
  // luminance — a hue-preserving chroma compression, the same move AgX's inset
  // makes upstream in a wider gamut. On a NEUTRAL it does exactly nothing,
  // because max equals luminance there and the pull distance is zero, so it
  // cannot touch the sky, the sun disc or sunlit sandstone. It only ever acts
  // on the one thing that was broken: a single hot channel.
  //
  // Knee 0.62, matching the shoulder knee — above that the S-curve is already
  // rolling off, so a channel arriving here is on its way to white regardless
  // and the only question is whether it gets there alone or with its
  // neighbours.
  gamutKnee: 0.62,
  // 0.55 at full overshoot. Measured on the same terracotta: max channel 0.788
  // -> 0.70, which lands the slab near 217 out of 255 instead of clipped, and
  // the hue stays put. Above ~0.75 the terracotta visibly desaturates toward
  // salmon, which is a different bug.
  gamutDesat: 0.55,

  // --- toe -----------------------------------------------------------------
  //
  // A REAL TOE, which this grade did not have.
  //
  // What was here was a black LIFT: `toe + (1 - toe) * c`, 0.003 of it, which
  // raises the floor and compresses nothing. Measured across all eight harness
  // shots the result was 0.00% clipped low with the 1st percentile between 38.8
  // and 57.4 — a dynamic range of about 144 code values out of 255 with no
  // black anywhere in it. Every genuinely occluded corner in the game arrived
  // at 40+ and read as grey paint.
  //
  // The shape is a gamma that decays with brightness:
  //
  //     out = c ^ ( 1 + toeStrength * exp( -c / toeWidth ) )
  //
  // At c = 0 the exponent is 1 + toeStrength and the curve crushes hard; by the
  // mid-tones the exponential has died and it is the identity. It is smooth
  // everywhere — no knee to show up as a band on a soft gradient, which a
  // piecewise power would give — monotonic everywhere (the derivative is
  // positive for every c in (0,1], so it can never invert two neighbouring
  // values), and it fixes both endpoints exactly: 0 stays 0 and 1 stays 1, so
  // the white point the shoulder normalises to is untouched and this can sit
  // after the shoulder without disturbing it.
  //
  // 2.39 and 0.156 are SOLVED, not chosen, against two measured constraints
  // and a two-equation fit:
  //
  //   - closeup.png's 1st percentile arrives here at 0.216 and has to leave
  //     under 22/255, which fixes the exponent there at 1.60;
  //   - its 50th percentile arrives at 0.489 and must not lose more than about
  //     four code values, which caps the exponent there at 1.10.
  //
  // Those two pin the pair exactly. The result puts genuinely occluded geometry
  // at 8-15 code values (an input of 0.16 lands on 11), which is what the art
  // review asked for, and costs the mid-tones about 3 codes across the set.
  toeStrength: 2.39,
  toeWidth: 0.156,
  // Black lift in code values / 255, applied last so it cannot push anything
  // past 1. Under one code value: this is not the toe, it is the toe's floor —
  // enough that the darkest corner of an archway has air in it rather than
  // being a dead hole, and small enough that the toe above still gets to reach
  // single digits.
  toe: 0.003,

  // --- shoulder ------------------------------------------------------------
  //
  // Knee, in post-contrast units. Above this the curve rolls off exponentially
  // instead of clipping flat, so cloud and specular separation survives the
  // last fifth of the range.
  shoulder: 0.62,
  // Softness, in the same units. The roll-off is NORMALISED (see
  // shoulderParams) so that the WHITE POINT below maps to output 1.0 exactly.
  // Without that normalisation the curve asymptotes short of white and every
  // bright surface in the game piles up in a 30-code-value band — the classic
  // "milky pastel wash with no white in it" failure.
  shoulderSoft: 1.20,

  // --- white point ---------------------------------------------------------
  //
  // THE INPUT CODE VALUE THAT BECOMES DISPLAY WHITE. This grade did not have
  // one, which is to say its white point was 1.0, which is to say it had no
  // white point at all — and it showed. Measured across all eight harness
  // shots: 99th percentile 155-185, clipped-high 0.000%, brightest pixel in the
  // entire set 251. Nothing in this game was ever white, including the sun.
  //
  // The reason is arithmetic, not taste. AgX's log range puts display white at
  // +4.03 EV above 1.0 linear, i.e. at a scene value of 16.3; the brightest
  // surface this level produces after metering is about 2.8, and the sky's
  // solar disc is authored at 5. Neither is remotely close, so the top four
  // stops of the transform were dead code and every highlight was delivered
  // into the upper mid-tones.
  //
  // 0.885 says: a display value of 0.885 out of AgX is as bright as this game
  // gets, so print it as white. Sun-facing brass, the solar disc and the
  // emissives cross it; sunlit sandstone does not. It only ever rescales the
  // range ABOVE the shoulder knee — mid-tones and shadows come through the
  // identical curve, which is the whole reason it is implemented here rather
  // than as an exposure or slope change.
  //
  // 0.870, down from 0.885. The set still measured 0.01-0.23% clipped high,
  // i.e. a golden-hour game with no highlights in it: p99 across all eight
  // shots landed between 161 and 209 with nothing at white, so the sun disc,
  // the lantern globes and the raked brass all arrived as pale grey shapes.
  // A backlit golden-hour frame should sit nearer 1-2% clipped — that clipping
  // IS the light source. Measured at 0.858 the terrace went to 2.9% and the
  // gaps shot to 3.7%, which is past character and into blown; 0.870 lands the
  // set between roughly 0.2% and 2%. Below ~0.85 the near column in the
  // underpass shot also starts losing its form, which is a readability bug on
  // a runnable surface.
  whitePoint: 0.870,
}

/**
 * Derive the shoulder constants, including the normaliser that guarantees
 * scurve(whitePoint) === 1.
 */
function shoulderParams(g) {
  const k = Math.min(0.98, Math.max(0.05, g.shoulder))
  const s = Math.max(1e-3, g.shoulderSoft)
  const w = Math.min(1, Math.max(0.2, g.whitePoint ?? 1))
  // The post-contrast value the white point produces. Everything from the knee
  // to here is mapped onto [knee, 1]; anything above simply clips, which is
  // what a white point is for.
  const cMax = g.pivot * Math.pow(w / g.pivot, g.contrast)
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
  // Exponents are grade parameters now rather than literals — see the note on
  // shadowFalloff. They set how far up the range each tint reaches, which for
  // this look is a more consequential number than the tints themselves.
  const shadowW = Math.pow(1 - Math.min(1, l1), P.shadowFalloff ?? 2.2)
  const highW = Math.pow(Math.min(1, Math.max(0, l1)), P.highlightRise ?? 2.0)
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

  // 5. gamut guard — the same pull toward luminance, but weighted by the MAX
  // CHANNEL rather than by luminance, which is the quantity that clips. See
  // the note on gamutKnee: this is what stops a saturated terracotta from
  // arriving with its red at 1.05 and its luminance at 0.4, which is invisible
  // to step 4 and was 62% of underpass.png's clipped pixels. Zero effect on a
  // neutral, by construction — there, max is luminance and the pull is zero.
  const knee = P.gamutKnee ?? 1
  const mx = Math.max(r, g, b)
  if (mx > knee) {
    const over = Math.min(1, (mx - knee) / Math.max(1e-4, 1 - knee))
    const gd = (P.gamutDesat ?? 0) * over
    r += (l2 - r) * gd
    g += (l2 - g) * gd
    b += (l2 - b) * gd
  }

  // 6. filmic S-curve, per channel
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
  c = Math.min(1, Math.max(0, c))
  // The toe: a gamma that decays with brightness. AFTER the shoulder rather
  // than before it, which is safe precisely because this curve fixes 1 exactly
  // (1^anything is 1) — so the shoulder's normalisation still lands the white
  // point on display white, and the toe's whole effect stays in the bottom
  // third where it was solved for. See toeStrength.
  const ts = P.toeStrength ?? 0
  if (ts > 0 && c > 0) {
    c = Math.pow(c, 1 + ts * Math.exp(-c / Math.max(1e-3, P.toeWidth ?? 0.14)))
  }
  // The floor last, as a lift of the whole range so it cannot push anything
  // past 1.
  return P.toe + (1 - P.toe) * c
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
