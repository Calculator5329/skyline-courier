/**
 * Quality levels — the plumbing behind the eventual Lite Mode setting.
 *
 * ONE object per level, holding every knob that costs real frame time, so a UI
 * (and the console, and the harness) all turn the same thing. See
 * `docs/lite-mode.md` for the measured cost of each level and the honest
 * account of what it does to the image.
 *
 * `high` is not "the fast path plus extras" — it is a verbatim restatement of
 * what the renderer did before this file existed. That is deliberate and it is
 * the property to preserve: the default must be byte-identical to the shipped
 * look, so that adding a settings menu can never be the thing that changed how
 * the game looks for someone who never opens it.
 *
 * WHAT IS NOT HERE, and why — every one of these was measured (docs/perf.md)
 * and does not belong to a quality slider:
 *
 *  - The shadow map. `−shadow` is inside the noise on every shot on both
 *    themes at every resolution measured. Dropping its size would cost image
 *    and save nothing.
 *  - The bloom pyramid. `−bloom` is likewise inside the noise; it runs on a
 *    mip chain that is 1/4 the pixels before it starts.
 *  - Level or backdrop geometry. The renderer is fill-bound, not
 *    geometry-bound: `−backdrop` is free, and `−level` only looks expensive
 *    because hiding the level removes most of the SHADED PIXELS in frame, not
 *    because of its triangles. A draw-distance slider here would be a visual
 *    cost with no frame-time credit, which is the worst kind of setting.
 *
 * The knobs that ARE here are the ones the ablation actually found: pixels, and
 * the contact-shadow pass that consumes them.
 */

/**
 * @typedef {object} QualityLevel
 * @property {string} label        what a UI would print
 * @property {string} note         one honest sentence about the trade
 * @property {number} pixelRatioCap  ceiling on devicePixelRatio (src/main.js)
 * @property {number} renderScale    internal resolution multiplier, 1 = native
 * @property {boolean} contactShadows whether the prepass + march run at all
 * @property {number} contactScale   contact buffer size relative to the frame
 * @property {number} contactSteps   ray-march steps
 * @property {number} aoTaps         broad AO taps
 * @property {number} aoNearTaps     short-radius AO taps (<= aoTaps)
 */

/** @type {Record<string, QualityLevel>} */
export const QUALITY_LEVELS = {
  high: {
    label: 'High',
    note: 'Everything on, at native resolution. The reference image.',
    pixelRatioCap: 2,
    renderScale: 1,
    contactShadows: true,
    contactScale: 1,
    contactSteps: 14,
    aoTaps: 8,
    aoNearTaps: 5,
  },

  /**
   * The tier that exists because the pixel-ratio cap is so coarse.
   *
   * 2 -> 1 is a FOUR-times cut in pixels, which on a fill-bound renderer is
   * most of the frame — far more than a player with a mildly slow machine
   * needs to give up. 1.5 is 2.25x the pixels of native instead of 4x, and on
   * a HiDPI panel that is still comfortably past the point where the
   * supersample stops being visible.
   */
  balanced: {
    label: 'Balanced',
    note: 'Slightly softer on a HiDPI display; contact shadows unchanged in reach, resolved at half rate.',
    pixelRatioCap: 1.5,
    renderScale: 1,
    contactShadows: true,
    contactScale: 0.5,
    contactSteps: 14,
    aoTaps: 8,
    aoNearTaps: 5,
  },

  /**
   * Lite. The contact pass SURVIVES, at a quarter of the pixels, because
   * turning it off is the one change available here that restyles the game
   * rather than softening it: the sun sits at ~10 degrees, so ambient does
   * nearly all the lighting, and the AO in this pass is what puts form into
   * that ambient. Without it every wall/floor junction flattens and the scene
   * reads as untextured primitives — the exact failure the pass was written to
   * fix. A slow machine should get a soft version of this game, not a
   * different-looking one.
   *
   * NOTE THE TAP COUNTS: identical to `high`, and that is a measurement, not
   * an oversight. Dropping the march to 10 steps and the AO to 6/4 taps was
   * measured (`perfprobe --modes base,chalf,clite`) and came back
   * indistinguishable from `chalf` on every shot on both themes — sometimes
   * slower. Skipping the two bilateral blur passes entirely (`noblur`) is also
   * free. So this pass is not bound by its arithmetic or by its blur; it is
   * bound by the number of pixels it runs at and the dependent texture fetches
   * those pixels make. Cutting taps would therefore be pure image loss at zero
   * saving, which is the worst trade in this file.
   *
   * The knobs stay wired because they are the right knobs to reach for on a
   * part with a different balance — an integrated GPU is far more likely to be
   * ALU-bound than this one. Turn them when a measurement on that part says to,
   * not before.
   */
  lite: {
    label: 'Lite',
    note: 'Native resolution, no supersample. Contact shadows and AO are softer and lose their finest creases at distance.',
    pixelRatioCap: 1,
    renderScale: 1,
    contactShadows: true,
    contactScale: 0.5,
    contactSteps: 14,
    aoTaps: 8,
    aoNearTaps: 5,
  },
}

/** The level applied when nobody has chosen one. Must equal today's look. */
export const DEFAULT_QUALITY = 'high'

export const QUALITY_NAMES = Object.keys(QUALITY_LEVELS)

/** Resolve a name to a level, falling back to the default rather than throwing. */
export function resolveQuality(name) {
  return QUALITY_LEVELS[name] ? name : DEFAULT_QUALITY
}
