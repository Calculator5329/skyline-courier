import * as THREE from 'three'

/**
 * THEMES — the look of a world, as data.
 *
 * `docs/scaling-plan.md` committed to "a theme is a data change", and then
 * measured that 48 colours live outside `PALETTE` and classified a structural
 * theme (ruins, ice, industrial) as 2-3 sessions rather than a repaint. Both
 * halves of that are true, and this file is the honest middle: the LIGHT and
 * ATMOSPHERE half of a theme is genuinely data and lives here; the SURFACE
 * half (canvas painters, ashlar coursing, rivet pitch) is structural and still
 * lives in `materials/textures.js`.
 *
 * So this descriptor deliberately does not pretend to cover everything. It
 * covers what decides whether a frame reads as golden-hour or as a void:
 * sun, lights, sky gradient, fog, motes, grade and exposure. That is the set
 * that made `docs/art-direction-void.md`'s value-structure table achievable
 * without touching a single painter.
 *
 * ADDING A THEME: copy `skyline`, change numbers, and check the result against
 * the measured acceptance table for that theme. Do not add a theme by editing
 * `skyline` — it is the shipped look and it is the regression baseline.
 */

// ---------------------------------------------------------------- skyline

/**
 * The shipped golden-hour archipelago. These values are LIFTED VERBATIM from
 * where they were hardcoded, so selecting `skyline` must produce a frame
 * identical to the one before this file existed. If it does not, that is a
 * bug in this refactor and not a new artistic decision.
 */
const skyline = {
  name: 'skyline',
  label: 'Skyline',

  // Golden hour: the sun sits LOW. This single number does more for the look
  // than any shader in the project — a high sun flattens everything into
  // top-down midday light and no amount of grading recovers the rim-lit,
  // long-shadowed read the reference depends on. (Moved from world.js:211.)
  sunDir: [-0.62, 0.17, 0.77],

  light: {
    hemiSky: 0x9fc0b0, hemiGround: 0xffd7a8, hemiIntensity: 0.25,
    keyColor: 0xffca7d, keyIntensity: 3.1,
    fillColor: 0x9fc4b4, fillIntensity: 0.45, fillPos: [30, 18, -40],
    bounceColor: 0xffe0b4, bounceIntensity: 0.3,
  },

  // null = use the module defaults in render/skygrad.js unchanged.
  sky: null,
  skyRadius: 900,

  fog: { density: 0.0030, color: null },   // null = follow the sky horizon

  // null = the measured defaults in render/patch.js, which were tuned against
  // this theme's own shot set. Do not restate them here.
  aerial: null,

  motes: {
    count: 900,
    color: [1.0, 0.94, 0.80],
    // Drift box, relative to the player. Kept as the shipped literals.
    spread: [260, 90, 260],
    rise: 0.0,
    cluster: 0,
  },

  /** Energy beams are a void element (art-direction-void.md §4.4). */
  beams: false,

  /**
   * The distant scenery layer (`src/fx/voidbackdrop.js`). Off here: the sunset
   * archipelago already carries its own far band as real ghost islands in
   * level.js, and two backdrops would be two answers to the same question.
   */
  backdrop: false,

  // null = the module default GRADE / exposure limits.
  grade: null,
  exposure: null,

  // The surface kinds an island reaches for. `drumPlatform` already takes
  // these per call; a theme names the DEFAULTS so a level does not have to.
  surfaces: {
    built: { capKind: 'porcelain', rimKind: 'terracotta', kind: 'stone', boulderKind: 'stone' },
    wild: { capKind: 'moss', rimKind: 'terracotta', kind: 'stone', boulderKind: 'stone' },
  },


  /**
   * The lit signals: the finish beacon, the checkpoint gates, and the lantern
   * glow that marks a grapple anchor.
   *
   * These were hardcoded in `level.js` and they are the loudest thing in any
   * frame, so under the void they read as warm brass in a violet cavern —
   * the single most out-of-palette element left in the theme. Grouped here
   * because they are one artistic decision: "what colour does this world use
   * to say YOU MAY USE THIS."
   */
  accents: {
    beacon: 0xffd08a,
    gateHot: 0xffc266,
    gateCool: 0x9fd8c8,
    lantern: null,          // null = PALETTE.brass, the shipped value
  },

  // Foliage belongs to a living world. A void has none, and this is the flag
  // that says so rather than every prefab guessing.
  foliage: true,
}

// ------------------------------------------------------------------- void

/**
 * THEME 2 — the Void. Every number here is derived from
 * `docs/art-direction-void.md`, which is itself derived from Ethan's reference
 * image. Read that document before changing anything in this block; the value
 * structure it specifies is measurable and is the acceptance test.
 *
 * The three decisions that matter most, and why:
 *
 * 1. THERE IS NO SUN. The reference is lit entirely from within — crystal and
 *    sigil-fire. But the renderer's shadow pass and `render/index.js` both
 *    want a directional light to exist, so the "sun" here is a dim, steeply
 *    raked violet fill that reads as ambient void-glow rather than as a light
 *    source. Turning the key down to ~0.35 (from 3.1) is what inverts the
 *    image from "lit by the sky" to "lit by objects".
 *
 * 2. THE EXPOSURE IS PINNED AND THE PLACEMENT IS `compensation`. This block
 *    first tried to widen the EV window (-7..+5) on the theory that a void
 *    meters below the daylight floor and needs room. Measured, that is not the
 *    problem: auto-exposure places the METERED AVERAGE at one fixed display
 *    value whatever the scene luminance is, so a wider window changes nothing
 *    about how dark the frame is and only adds room for the meter to wander.
 *    The window is now a pin and `compensation` is the dial. See the block on
 *    `exposure` below, which is the longest comment in this file because it is
 *    the thing most likely to be "fixed" back into murk.
 *
 * 3. THE GRADE GOES VIOLET IN THE SHADOWS AND COLD IN THE HIGHLIGHTS, and the
 *    toe is pulled DOWN hard. `art-direction-void.md` §2 asks for p1 in 0-6
 *    and spread > 200: that is a crushed toe with bright emissive highlights,
 *    not an overall darkening. A frame that is uniformly dim passes "dark" and
 *    fails the brief — that is the murk failure mode and it is the likeliest
 *    way to get this wrong.
 */
const voidTheme = {
  name: 'void',
  label: 'The Void',

  // Steep and raked, so what little directional light exists rims the tops of
  // ruins rather than lighting their faces. Not a sun: a direction for the
  // ambient to fall from.
  sunDir: [-0.35, 0.62, 0.70],

  light: {
    // Violet from above, deep blue from below — the inverse of a warm ground
    // bounce. This carries most of the theme's colour on unlit rock.
    hemiSky: 0x6b4fa8, hemiGround: 0x1a1430, hemiIntensity: 0.44,
    // An eighth of skyline's key. The crystals are the light in this world;
    // this is only enough to rake a rim across the tops of the mass.
    keyColor: 0x9b7bff, keyIntensity: 0.38,
    // Cold magenta rim from the opposite side, so silhouettes separate from
    // the fog instead of dissolving into it. art-direction-void.md §5:
    // "dark mass reads only when backed by something brighter".
    fillColor: 0xff3d6e, fillIntensity: 0.26, fillPos: [-40, 12, 36],
    bounceColor: 0x5b6cf6, bounceIntensity: 0.10,
  },

  sky: {
    /**
     * NOT A SKY — see `scVoidGradient` in render/skygrad.js, which is the
     * shape these colours are fed into. `voidMode` is what selects it, and it
     * reaches the dome, the aerial perspective's inscatter and scene.fog from
     * this one flag, so there is no way to half-convert the background.
     *
     * Only two of the four colours are read in void mode, and both are
     * MEASURED rather than picked off a swatch — the background is most of
     * most frames, so these two numbers move §2's whole table.
     *
     * `zenith` is the upper dome. It is dark but NOT black: a first pass at
     * 0x050308 measured p50 9 and 11% clipped to true black against targets of
     * 22-45 and 2-8%, which is a low-key image overshot into an empty one.
     * `horizon` is not a horizon — it is the violet haze the void deepens into
     * below eye level, and it is the same colour `fog` and the aerial
     * perspective terminate on, so all three move together or distance stops
     * agreeing with background. Their ratio is deliberately small (about 2.2x
     * in luminance): a steeper ramp is a horizon by another name, and it also
     * splits the shot set in half, since a frame looking down gets the haze and
     * a frame looking up gets the zenith.
     *
     * `deck` and `sun` are inert here and are kept only so a theme can be
     * switched back without a missing key.
     */
    voidMode: true,
    zenith: 0x1d1230,
    horizon: 0x2c1b45,
    deck: 0x241a42,
    sun: 0x8b5cf6,
  },
  skyRadius: 900,

  // Nearly 3x skyline's. The depth read in the reference is carried entirely
  // by aerial perspective toward violet, and it is also what makes a fall read
  // as bottomless without modelling a bottom. Note this is the FALLBACK path
  // only (see the block comment in world.js); `aerial` below is the one that
  // actually draws the depth bands.
  fog: { density: 0.0082, color: 0x2c1b45 },

  /**
   * THE THREE DEPTH BANDS of art-direction-void.md §5: "near mass nearly black
   * and sharply lit; mid ruins in violet fog; far structures washed almost to
   * the fog colour. If everything sits in one band the space collapses."
   *
   * The skyline theme's numbers are tuned for the opposite problem — a
   * luminous sky that wants to eat the archipelago, so they run a thin haze
   * (0.0014/m) with a high transmittance floor (0.20) to keep four bands
   * legible. A void has no luminous background to be swallowed by, and it
   * wants exactly the collapse the skyline is defending against, just further
   * out: things must genuinely disappear, because §6 leans on the fog to hide
   * that the void has no bottom.
   */
  aerial: {
    // 2.4x skyline. At 0.0034/m a surface at 80 m is a third hazed (the mid
    // band), at 200 m it is 80% (the far band), and the near band inside 30 m
    // is essentially untouched and reads on its own lighting alone.
    density: 0.0034,
    // 0.04, down from 0.20. The floor is what stops the far archipelago
    // converging on one value in the skyline theme, and here converging on one
    // value is the brief: "far structures washed almost to fog colour".
    floor: 0.04,
    // Doubled. §5's "silhouette against glow" is a composition rule, but in a
    // near-black frame the rim is the only thing keeping a dark ruin from
    // dissolving into a dark fog — the value difference alone is not enough.
    rim: 0.32,
    // High. AgX's inset desaturates hardest exactly where this theme is most
    // vulnerable: a low-contrast violet haze over a violet ruin drifts to grey,
    // and grey is the failure mode §8 names first.
    chroma: 0.72,
    // ZERO. There is no sun; a forward-scatter lobe is a solar hotspot painted
    // onto the haze, and it would print a bright patch in one azimuth of a
    // world whose entire premise is that no direction is brighter than another.
    sunLobe: 0.0,
    // Near-neutral extinction with a slight blue lead. The skyline's
    // (0.72, 1.0, 1.62) is a warm-ward drift for a golden sky; here the haze is
    // already violet and a strong per-channel skew would swing it toward blue
    // and lose the red end of the palette.
    extinction: [0.92, 1.0, 1.12],
  },

  motes: {
    count: 1400,
    // Violet-white, well over 1.0 so they catch the bloom the way dust near a
    // bright emissive actually does.
    color: [1.35, 1.05, 2.10],
    spread: [220, 140, 220],
    // The void has a current. Slow upward drift reinforces the climb.
    rise: 0.35,
    // Just over half the budget bound to the energy beams. See the block
    // comment in world.js: dust with no light on it is invisible, so an even
    // spread in a near-black scene is mostly wasted particles.
    cluster: 0.55,
  },

  /** §4.4. Off for any theme that does not ask for it. */
  beams: true,

  /**
   * §5, "depth in three bands". ON, and it is the thing that stops the void
   * being a course in front of flat violet fog — see `src/fx/voidbackdrop.js`.
   */
  backdrop: true,

  grade: {
    // Crushed toe, violet shadows, cold highlights, and saturation pushed
    // hard — a desaturated void reads as grey murk, which is the failure mode
    // art-direction-void.md §8 calls out by name.
    shadowTint: [0.048, -0.008, 0.030],
    highlightTint: [0.016, -0.016, 0.026],
    saturation: 1.46,
    contrast: 1.52,
    shadowFalloff: 2.80,
    highlightRise: 1.85,
    highlightDesat: 0.03,
  },

  exposure: {
    /**
     * READ THIS BEFORE TOUCHING IT. Auto-exposure places the METERED AVERAGE at
     * one fixed display value regardless of how bright the scene is — that is
     * what it is for. So a theme cannot be made dark by turning its lights
     * down: dim the world and the meter simply opens up and hands back the
     * same mid-grey frame. That is the entire mechanism behind the murk this
     * theme measured as on its first capture (lum 78, p50 70, against a target
     * of 28-55 and 22-45), and `compensation` is the only knob that moves it.
     *
     * -1.43 is measured, not chosen: it is what lands p50 in §2's 22-45 band
     * and lum in its 28-55 band across the shot set, and it is checked by
     * `node tools/shotset.mjs --theme void`, not by eye.
     */
    compensation: -1.18,

    /**
     * THE EXPOSURE IS PINNED. minEV == maxEV, so the metering chain still runs
     * but its output is a constant and the void is rendered at a fixed EV.
     *
     * This is a deliberate answer to §7.4 ("expect to clamp or bias it per
     * theme, and treat a drifting exposure as a bug"), and it is not the lazy
     * version of that answer — it was arrived at by measuring. `tools/
     * evprobe.mjs` reads the metered EV out of the 1x1 adaptation target, and
     * on the void course it comes back between -2.35 and -4.34 depending on
     * the shot: two full stops of disagreement about how bright the same world
     * is, driven entirely by how much geometry happens to be in frame. Left
     * free, that is not adaptation, it is the image changing brightness because
     * the player turned around.
     *
     * The deeper reason is that auto-exposure is answering a question a void
     * does not have. It exists to track a CHANGING lighting condition — indoors
     * to outdoors, shade to sun. There is no sun here and no indoors: every
     * frame is lit by the same emissives at the same intensities, so the honest
     * range of scene luminance is zero stops and any movement in the meter is
     * measuring composition rather than light. Pinning also makes the whole
     * §2 acceptance table a property of the theme rather than of which way the
     * camera was pointing when it was captured.
     *
     * -3.5 is the middle of the measured range. It is a pure convention: with
     * the EV fixed, `compensation` above is the only dial that matters, and
     * moving both is how you end up unable to say what either one does.
     */
    minEV: -3.5,
    maxEV: -3.5,

    /**
     * A sky texel votes at 5% of a geometry texel — the sky rejection stays,
     * and stays STRONG, but for the opposite reason to the skyline's.
     *
     * There, the mask keeps a blown sky from crushing the route to silhouette.
     * Here the background is the darkest thing in the frame, so letting it vote
     * would drag the log-average down, open the exposure up, and lift the void
     * itself to mid-grey — the murk failure arriving through the meter instead
     * of through the lights. Rejecting it means the meter is looking at the
     * rock, which is the surface whose value §2 actually specifies.
     */
    skyWeight: 0.05,

    /**
     * ...and 1.0, i.e. the screen-position bias is OFF, which is a REVERSAL of
     * what this block used to say.
     *
     * The bias down-weights the top of the frame because in an outdoor scene
     * the top of the frame is a bright sky and a bright sky is the outlier. In
     * a void the top of the frame is the DARKEST part of the image, so the term
     * is not rejecting an outlier any more — it is discarding a third of the
     * votes for no reason, and every time the player pitches up (which §5 says
     * is most of the time here) the surviving votes change and the meter moves.
     * The coverage mask above does the sky rejection properly, using knowledge
     * of what is actually sky rather than a proxy that assumes it is overhead.
     */
    horizonBias: 1.0,

    /**
     * Tap clamp 0.6 linear, down from 8.0, and this is the single change that
     * makes the metering loop stable in a world lit by objects.
     *
     * The clamp bounds what any one texel can contribute before the log. In the
     * skyline theme 8.0 sits above every real surface and only ever bites on a
     * specular or the solar disc. In the void the beams are authored at 30-70
     * and the crystal cores are not far behind, so at 8.0 a beam swinging into
     * frame is worth roughly seven stops of extra vote on every texel it covers
     * — and the image visibly stops down as you run past a landmark. 0.6 is
     * above lit rock and below every emissive: an emissive then counts as "a
     * bright surface", once, which is the metering judgement actually wanted.
     */
    tapClamp: 0.6,
  },

  /**
   * THE SURFACE HALF OF THE THEME.
   *
   * This block was the missing half of the descriptor and it is why the void
   * measured dark and still read wrong. `PALETTE.stone` and the `stone` painter
   * were SHARED with the sunset level, so the void's mass was the archipelago's
   * cool grey-green limestone with a violet light on it — Ethan, after playing
   * it: the rock "is nowhere close to the reference image". Every number in §2
   * can pass while that is true, because §2 only says the LIGHTING is right;
   * §0 warns about exactly that reading.
   *
   * Three consumers, all of which existed before this block did:
   *
   *   kinds  → `materials.js` `resolveKind`. Every `L.solid(..., 'stone')` in
   *            the void course becomes `voidrock` without one line changing in
   *            `voidkit.js`, `levels/void.js` or `kit.js`.
   *   macro  → `materials/shader.js` `setMacroColors`. The five sky-derived
   *            colours every lit texel passes through.
   *   shade  → `voidkit.js`'s `emit()`, which already reads it and has been
   *            waiting for someone to set it.
   */
  surfaces: {
    /**
     * The alias map. `stone` is the one that is load-bearing today — it is what
     * `voidkit.js` defaults every emitter to and what `levels/void.js` passes
     * for its placeholder slabs, so it is the entire visible mass of the level.
     *
     * The other four are the same decision made in advance rather than four
     * more hardcoded fallbacks: the moment a prefab asks for a dressed face
     * (`porcelain`), an accent (`terracotta`), a metal (`brass`) or planting
     * (`moss`), it gets the void's carved stone instead of the archipelago's
     * sandstone, roof tile, gold or turf. §7.2: "a new prefab must be
     * theme-neutral in shape and take its colours from the theme descriptor" —
     * this is how a prefab written for the sunset level obeys that rule in the
     * void without knowing the void exists.
     */
    kinds: {
      stone: 'voidrock',
      porcelain: 'voidcarved',
      terracotta: 'voidcarved',
      brass: 'voidcarved',
      moss: 'voidrock',
    },

    /**
     * The five shared colours, re-derived for a world with no sun.
     *
     * Each is a linear multiplier on albedo (or, for `patina`, a substance
     * colour), and each answers the same question the skyline answers with the
     * golden hour: what does this part of the surface actually SEE?
     */
    macro: {
      // A pocket sees the violet dome and nothing else, so it goes dark AND
      // further toward violet. The skyline's (0.52, 0.68, 0.64) is the cool
      // GREEN zenith of skyenv.js — under the void that paints a green line
      // into every fracture in the level, which is the one hue §3 has no room
      // for.
      cavity: [0.42, 0.34, 0.60],
      // The sun-away hemisphere. There is no sun, so this is really "the side
      // the ambient fill does not reach", and in a violet fog that side goes
      // blue-violet rather than green-cyan.
      shade: [0.78, 0.62, 1.05],
      // An UP face. Kept near unity in luma for the reason the skyline's block
      // gives at length — a chromatic correction that changes the frame's
      // energy is an exposure change in disguise, and this theme's exposure is
      // pinned precisely so that cannot happen. Inert today (both void surfaces
      // run `upWarm: 0`), and set correctly anyway so it stays a rotation and
      // not a surprise if a later surface wants it.
      skyWarm: [0.94, 0.86, 1.14],
      // What a polished face mirrors back. There is no cloud sea, so this is
      // the violet haze itself rather than a bright warm band. Also inert
      // today: both void surfaces run `glint: 0`, because §3 says anything that
      // reads as a horizon line is wrong and a glint sweep IS a horizon.
      horizon: [0.62, 0.44, 1.10],
      // Copper carbonate. Nothing in the void is wet and no surface here asks
      // for a patina; left at the shipped value rather than invented.
      patina: 0x4e8f7a,
    },

    /**
     * The flat vertex-tint multiplier `voidkit.js` applies to every box and
     * mesh it emits. 1.0 — and that is the point.
     *
     * voidkit added the hook because the shared `stone` albedo was too pale for
     * the void and turning it down was the only lever a prefab kit had. With
     * the albedo itself now correct, using it would be darkening a material
     * that is already at its authored value, and a vertex tint cannot add the
     * violet cast §3 actually asks for — it can only take value away, which is
     * the murk failure of §2 arriving through a different door.
     *
     * Kept, named and explicitly 1.0 so the next reader can see the decision
     * rather than the absence of one.
     */
    shade: 1.0,

    built: { capKind: 'porcelain', rimKind: 'porcelain', kind: 'stone', boulderKind: 'stone' },
    wild: { capKind: 'porcelain', rimKind: 'porcelain', kind: 'stone', boulderKind: 'stone' },
  },


  /**
   * Violet says "route", magenta says "objective". `voidkit.js` already reads
   * `rune`/`sigil`/`cool` from here for its inlays, so the crystals, the runes
   * and the signals all come out of one palette rather than three.
   */
  accents: {
    beacon: 0xc08bff,
    gateHot: 0xff4d7e,
    gateCool: 0x6fd0ff,
    lantern: 0xa77dff,
    rune: 0x8b5cf6,
    sigil: 0xff2d55,
    cool: 0x3b82f6,
  },

  foliage: false,
}

export const THEMES = { skyline, void: voidTheme }
export const DEFAULT_THEME = 'skyline'

let active = THEMES[DEFAULT_THEME]

/**
 * Pick the theme for this boot.
 *
 * URL first so the harness and a shared link can both address a theme without
 * touching stored state, then localStorage, then the default. Deliberately
 * read ONCE at boot: a theme swap mid-run would have to rebuild the IBL, the
 * grade LUT and every material, and half-swapping is how you get a frame that
 * is neither look.
 */
export function selectTheme(name) {
  if (name && THEMES[name]) { active = THEMES[name]; return active }
  let want = null
  try {
    want = new URLSearchParams(location.search).get('theme')
      || new URLSearchParams(location.search).get('level')
  } catch { /* no location (harness/node) */ }
  if (!want) {
    try { want = localStorage.getItem('skyline-courier:theme') } catch { /* private mode */ }
  }
  active = THEMES[want] || THEMES[DEFAULT_THEME]
  return active
}

export function getTheme() { return active }

/** Convenience for the places that want a THREE type rather than a triple. */
export function themeSunDir(t = active) {
  return new THREE.Vector3(t.sunDir[0], t.sunDir[1], t.sunDir[2]).normalize()
}
