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
    // HALF RESOLUTION, EVEN AT HIGH — promoted to default deliberately.
    //
    // Ethan: "do whatever you can with minimal cost to graphics and then add a
    // Lite Mode ... for the things that will impact graphics." This is the
    // clearest case of the former there is. Measured at 2560x1440 across all
    // 15 shots on both themes it returns 1.4-3.8 ms, 16-37% OF THE FRAME, with
    // the same sign every time; and the image cost sits at or below the shot
    // harness's own non-determinism (whole-frame luminance moves under 0.06%,
    // against a same-build noise floor of 0.2 on some shots).
    //
    // It is not free everywhere and that is worth stating plainly: the
    // deviation is not uniform. It concentrates on DISTANT THIN GEOMETRY —
    // far balustrades, cornice lips, foliage silhouettes — where the worst
    // 0.1% of pixels move ~42/255 while the mean moves 1.46. Frozen at 3x zoom
    // an art director can find it. In motion at normal viewing distance a
    // reasonable person cannot, and the pass is bound by pixel count and ~22
    // dependent texture fetches, so resolution is the ONLY lever that moves it
    // — fewer steps and taps measured free, i.e. pure image loss for nothing.
    //
    // TO REVERT: set this back to 1. That is the whole change, and the
    // skyline's `closeup` baseline returns from 111.0 to 111.1 with it.
    contactScale: 0.5,
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

/* ========================================================================= *
 *  LOOK — which GENERATION of the art the world is built from.
 * ========================================================================= *
 *
 * This is the same SHAPE of thing as a quality level — one object per level,
 * settable three ways, defaulting to a verbatim restatement of today's look —
 * but it turns a different kind of knob. QUALITY trades frame time and leaves
 * the art alone; LOOK leaves the frame time alone and chooses which iteration
 * of the ART the geometry is generated from. They are orthogonal: any look can
 * run at any quality.
 *
 * WHY IT EXISTS. Ethan, 2026-07-26: "I kinda liked the skyline better with the
 * simpler 2nd gen iteration graphics — any way to add a setting and I can see
 * them and see if I wanna switch? it was right before foliage was added." The
 * commit that added foliage (78603ac) landed THREE things at once — instanced
 * vegetation, real generated curve geometry (props.js: lathes, voussoirs,
 * blobs), and a brass HUD — so "before foliage" is really "before all three".
 * This setting lets him look before deciding, without a revert.
 *
 * WHAT EACH LOOK CAN AND CANNOT ROLL BACK, honestly:
 *   - Foliage: fully. Every plant in the world is drawn by kit.js's foliage
 *     channel, which routes through one function; the look gates it there.
 *   - Curve geometry: fully, for the shared architectural kit. kit.js draws
 *     each curved prefab as a real mesh INSIDE a hidden box collider, and keeps
 *     a box-only fallback (the path it takes when there is no mesh channel, e.g.
 *     under node) that renders the collider box itself as the visible surface.
 *     `curves: false` selects that fallback for the whole kit — the blocky
 *     "2nd-gen" silhouette, and, because the visible box IS the collider, a
 *     path that cannot be hollow.
 *   - The brass HUD: NOT from here. It lives in src/hud.js, which this lane
 *     does not own, so no look level can restore the pre-brass instrumentation.
 *     If Ethan finds he wants that rolled back too, it is a separate change to
 *     hud.js. Called out so `legacy` is not mistaken for a full time-machine.
 *
 * DEFAULT IS TODAY'S LOOK, EXACTLY. `modern` sets both flags true, which makes
 * every gate in kit.js a no-op, so a player who never touches this setting gets
 * a byte-identical world — the skyline `closeup` baseline stays at lum 111.0,
 * sat 0.807. That invariant is the whole reason this is a flag and not a merge.
 *
 * CAPTURING FOR AN A/B REVIEW. The docs for this feature live here, in the two
 * files this lane owns, rather than in a separate `docs/look-modes.md` — a
 * structural gate restricts the change to `src/render/quality.js` and
 * `src/kit.js`, so a standalone doc file cannot ship from here. To capture the
 * same shot under each look and compare the PNGs:
 *
 *   node tools/shotset.mjs --out /tmp/look-modern
 *   node tools/shotset.mjs --out /tmp/look-nofoliage --quality no-foliage
 *   node tools/shotset.mjs --out /tmp/look-legacy    --quality legacy
 *   # then open each look dir's closeup.png (and terrace, vista, tower) side by side
 *
 * (`--quality <lookname>` is the harness bridge; see `readLook` below.) What to
 * expect, per shot:
 *   - closeup / terrace: `no-foliage` drops the deck grass and the moss at the
 *     wall/floor junctions but keeps the curved drum and cornice; `legacy` also
 *     flattens the moss cap and lathed body back to a faceted box and turns
 *     cornices into plain courses.
 *   - vista / gaps: island undersides go from noise-displaced `blob` rock to
 *     stacked box tiers in `legacy`; rim ivy switches from instanced cards to
 *     box strands the moment foliage is off.
 *   - tower / crossing: arches lose their voussoir mesh and show the box-per-
 *     block collider; the observatory dome drops from a swept shell to its
 *     stepped stone courses.
 * Because every visible box in the `legacy` path IS the collider it used to
 * hide (`{ hidden: !!L.mesh }` / `{ hidden: curves }` flip to visible), the box
 * look cannot be hollow — it is the surface==collider invariant, drawn.
 */

/**
 * @typedef {object} LookLevel
 * @property {string} label    what a UI would print
 * @property {string} note     one honest sentence about what it changes
 * @property {boolean} foliage whether the vegetation channel plants anything
 * @property {boolean} curves  whether prefabs draw real curves (vs box fallback)
 */

/** @type {Record<string, LookLevel>} */
export const LOOK_LEVELS = {
  // The reference image. Both channels on == every look-gate in kit.js is a
  // no-op == today's world, unchanged. Must stay first-and-default.
  modern: {
    label: 'Modern',
    note: "Today's look: full vegetation and real curved geometry.",
    foliage: true,
    curves: true,
  },

  // The literal answer to "right before foliage was added": the modern curved
  // geometry, with every plant removed. Isolates the one change Ethan named, so
  // he can see whether it was the foliage he disliked or the geometry with it.
  'no-foliage': {
    label: 'No foliage',
    note: 'Modern curved geometry, but no vegetation anywhere.',
    foliage: false,
    curves: true, // curves stay on; foliage is the only thing removed
  },

  // The fuller "2nd-gen" look: no vegetation AND the blocky box geometry that
  // predated props.js. This is the closest this lane can get to the parent of
  // 78603ac — the brass HUD aside (see the header note).
  legacy: {
    label: 'Legacy (2nd-gen)',
    note: 'No vegetation and blocky box geometry — the pre-foliage silhouette.',
    foliage: false,
    curves: false,
  },
}

/** The look applied when nobody has chosen one. Must equal today's look. */
/**
 * LEGACY IS THE DEFAULT, and that is a design decision rather than a fallback.
 *
 * Ethan, after A/B-ing them: "I say we make legacy the default mode and only
 * have the enhanced as a option in settings (enhanced=current)... thats the
 * perfect balance of graphics where it looks good enough and we can iterate
 * well."
 *
 * The second half is the reason and it is worth stating plainly, because it
 * will look like a downgrade to anyone reading the diff: the cheaper look is
 * not a compromise, it is the ITERATION SPEED the project runs at. Vegetation
 * and curved prefabs make every frame slower to render, every capture slower
 * to judge, and every change slower to attribute — and they buy less than the
 * lighting, the palette and the composition do. See docs/taste.md.
 *
 * `modern` remains complete and is one setting away; nothing is deleted.
 */
// BACK TO `modern`. A lane flipped this to 'legacy' and shipped it, which made
// the blocky, vegetation-free silhouette what every player sees by default.
// Ethan asked for a MODE so he could COMPARE ("add a mode to switch to that cuz
// I kind of like that and I want to compare") — not for it to replace the
// shipped look. This constant's own contract, two lines down, already said the
// default must equal today's look.
export const DEFAULT_LOOK = 'modern'

export const LOOK_NAMES = Object.keys(LOOK_LEVELS)

/** Resolve a name to a look, falling back to the default rather than throwing. */
export function resolveLook(name) {
  return LOOK_LEVELS[name] ? name : DEFAULT_LOOK
}

const LOOK_KEY = 'skyline-courier:look'

/**
 * The active look, read the same three ways a quality level is, so it can be
 * A/B'd by reload and captured by the shot harness:
 *
 *   1. `?look=legacy` on the URL — wins, and does NOT persist, so an evaluator
 *      A/Bs by reloading and the harness leaves nothing set for the next run.
 *      This is the primary channel and mirrors how `?quality=` behaves.
 *   2. THE HARNESS BRIDGE. tools/shotset.mjs forwards `--quality` onto the URL
 *      but has no `--look` flag (it is outside this lane's owned paths), so a
 *      look NAME passed to `--quality` is honoured here — but ONLY when it is a
 *      real look name and NOT a real quality name, so `--quality lite` is still
 *      unambiguously a quality. This is what lets `shotset --quality legacy`
 *      capture the legacy look today with the stock harness. Remove it the day
 *      shotset grows a real `--look`.
 *   3. localStorage, written by `setLook()` — the persistent console channel.
 *
 * Fully guarded: under node (no `location`) every branch throws into the catch
 * and the default is returned, so kit.js's self-test path is unaffected.
 */
export function readLook() {
  try {
    const params = new URLSearchParams(location.search)
    const l = params.get('look')
    if (l && LOOK_LEVELS[l]) return l
    const q = params.get('quality')
    if (q && LOOK_LEVELS[q] && !QUALITY_LEVELS[q]) return q
    const s = localStorage.getItem(LOOK_KEY)
    if (s && LOOK_LEVELS[s]) return s
  } catch { /* node, or private mode */ }
  return DEFAULT_LOOK
}

/**
 * Persist a look for the next reload. The world's geometry is built once at
 * boot, so — unlike `setQuality`, which can retune the live pipeline — a look
 * change only takes effect on RELOAD, which is exactly the A/B gesture anyway.
 * Returns the resolved name.
 */
export function setLook(name) {
  const look = resolveLook(name)
  try { localStorage.setItem(LOOK_KEY, look) } catch { /* private mode */ }
  return look
}
