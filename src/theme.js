import * as THREE from 'three'
import { VOID_AUDIO } from './audio/void.js'

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

  /** Where this theme's four music tracks live, under the site root. */
  music: 'audio/',

  /**
   * The distant scenery layer (`src/fx/voidbackdrop.js`). Off here: the sunset
   * archipelago already carries its own far band as real ghost islands in
   * level.js, and two backdrops would be two answers to the same question.
   */
  backdrop: false,

  // null = the module default GRADE / exposure limits.
  grade: null,
  exposure: null,

  // null = the shipped grapple range (player.js TUNING.grappleRange) unchanged.
  // Range is the SHIPPED default here; only the void overlays a scale. See the
  // `grapple` block on that theme for the whole argument.
  grapple: null,

  // null = the shipped ambient-occlusion radii in render/contact.js, which
  // were tuned against THIS theme's masonry (a moss lip, a balustrade base, a
  // stair nosing) and are its regression baseline. Do not restate them here —
  // the defaults in contact.js ARE the skyline's tuning, and a value here would
  // be a second copy to keep in sync. The void overrides them because its
  // architecture is a class larger; see `ao` on that theme.
  ao: null,

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
    streak: null,           // null = the shipped wind-streak cream
    streakOverlay: null,
    streakGain: null,       // null = 1.0, the shipped strength
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
  // USER-FACING NAME. The level is called "The Underworld" everywhere a player
  // reads it; the INTERNAL identifier stays `void` — the theme key, the
  // `?theme=void` URL, the file names (levels/void.js, voidkit.js, voidfx.js),
  // the shot-table keys and ~forty commit messages. Renaming the identifier is
  // a large mechanical change with real risk, no user-visible benefit, and it
  // would break every bookmarked URL. So the label moved and the id did not.
  // Everything the player sees must route through THIS field (Ethan, 2026-07-26:
  // "call the void The Underworld instead."); a hardcoded name anywhere else is
  // a bug. See docs/art-direction-void.md §0c.
  label: 'The Underworld',

  /**
   * SHALLOW, not steep — lowered 2026-07-26 from [-0.35, 0.62, 0.70].
   *
   * The old direction was 62% vertical, so the strongest light in the level
   * fell on UP FACES: every platform top and, worst of all, the 26 m finish
   * plaza, which is most of the `summit` frame. Measured, that one shot came
   * back at lum 75 against §2's 28-55 while the three shots that look along the
   * shaft sat at 38-42 — the same lighting reading two different ways purely by
   * surface orientation. §4.1 says the great walls are the architecture and §5
   * says every vantage is framed by a vertical; a light that rakes floors is
   * lighting the one surface class the brief cares least about.
   *
   * At 0.26 the same key lands on WALLS. summit came down to 61 and the
   * vertical shots came UP without the exposure moving at all, which is the
   * shape of correction that says the direction was wrong rather than the
   * intensity.
   */
  sunDir: [-0.52, 0.26, 0.81],

  light: {
    /**
     * THE MASS IS BRIGHTER THAN THE SPACE BEHIND IT. That is the whole of the
     * 2026-07-26 change and it is §1's "lit BY OBJECTS and shaped by darkness"
     * stated as numbers: the background (see `sky` below) came down by about
     * three stops and these came up to meet it. Turned the other way round —
     * dim rock in front of lifted fog — the frame is dark-on-light, which is
     * the sunset level's value structure wearing a violet coat, and it is
     * exactly what the review found: "all geometry reads as black cutouts".
     *
     * WHICH OF THESE ACTUALLY LIGHT THE VOID, measured by zeroing them one at
     * a time rather than assumed:
     *
     *   key / fill / bounce   EVERYTHING. With all three at 0 the `summit`
     *                         frame falls from lum 68 to 30 and a quarter of it
     *                         clips to black. These are the void's light.
     *   hemisphere            ~1%. Zeroing `hemiIntensity` entirely moved
     *                         `summit` 68.0 -> 67.4 and `midclimb` 34.7 ->
     *                         34.6. The render pipeline's analytic sky IBL has
     *                         taken this light's job (see render/index.js), so
     *                         it is a floor under the ambient and nothing more.
     *                         It is kept at a plausible value and documented as
     *                         near-inert so the next person tuning this theme
     *                         does not spend an hour on a dial that is not
     *                         connected — which is what happened here.
     */
    // FLOOD DOWN, so unlit rock is actually near-black.
    //
    // Ethan, on the frame that got everything else right: "still too purple /
    // not black with blue red and purple highlights". He is describing the
    // difference between a world LIT violet and a world that is BLACK with
    // violet lights in it — §1's "lit BY OBJECTS and shaped by darkness".
    //
    // At hemi 1.10 / key 1.85 every surface in the level received enough
    // ambient violet to sit in the mid-tones whether or not anything was near
    // it, so nothing could read as unlit and therefore nothing could read as
    // HIGHLIT either. The emitters were bright but they had nothing dark to be
    // bright against.
    //
    // These are cut roughly to a third. The course now carries 211 anchor orbs,
    // red sigil rings, beams, veins and crystals — there is plenty of light in
    // the level; it simply needs somewhere dark to land.
    hemiSky: 0x6b46a8, hemiGround: 0x140c22, hemiIntensity: 0.34,
    keyColor: 0xb07dff, keyIntensity: 0.62,
    // Cold magenta rim from the opposite side, so silhouettes separate from
    // the fog instead of dissolving into it. art-direction-void.md §5:
    // "dark mass reads only when backed by something brighter".
    // The magenta rim survives at strength — §5's "silhouette against glow" is
    // what keeps a dark ruin from dissolving into dark fog, and with the flood
    // down it is doing more work, not less.
    fillColor: 0xff3d6e, fillIntensity: 0.72, fillPos: [-40, 12, 36],
    bounceColor: 0x6f52d8, bounceIntensity: 0.16,
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
     * agreeing with background. Their ratio is deliberately small (about 2.4x
     * in luminance): a steeper ramp is a horizon by another name, and it also
     * splits the shot set in half, since a frame looking down gets the haze and
     * a frame looking up gets the zenith.
     *
     * THESE TWO ARE ALSO THE VOID'S AMBIENT, which is why they were so
     * expensive to get wrong. The pipeline builds its analytic sky IBL from
     * them (render/skyenv.js), so dropping the dome three stops dropped the
     * light on the rock with it — the frame darkened as a whole and the value
     * ORDER did not change. The order only inverted once `light` above came up
     * by the same amount. Any future move here is two moves, or it is a
     * brightness change wearing a value-structure costume.
     *
     * `deck` and `sun` are inert here and are kept only so a theme can be
     * switched back without a missing key.
     */
    voidMode: true,
    // WIDENED, AND SPLIT IN HUE. Ethan, side by side with the reference: the
    // frame reads as "one value" and is "monochromatic".
    //
    // Two changes, and they are separate problems. VALUE: the ratio between
    // these was about 2.2x, so the background was a near-uniform field and the
    // dark masses had barely a step to silhouette against. It is now ~3.6x,
    // which is a real gradient without becoming a horizon LINE — the ramp is
    // still smooth over 130 degrees of dome (see `scVoidGradient`).
    //
    // HUE: they were the same violet at two brightnesses, which is why the
    // whole frame came out monochromatic. The zenith now sits blue-violet and
    // the deep sits magenta-violet, so the background alone carries two hues
    // and anything in front of it has something to separate from. The
    // reference does exactly this — cool above, warm-magenta below.
    // DARKENED BY ROUGHLY THREE STOPS, 2026-07-26, and this is the single
    // largest change the void has had. The harsh review of the rendered frames:
    // "the backdrop is the brightest thing in every frame, so all geometry
    // reads as black cutouts". Measured on the previous values, the dome
    // rendered around rgb(150,110,200) — a lavender field brighter than every
    // lit rock face in front of it, covering 55-65% of `plunge` and `midclimb`
    // and putting a clean silhouette LINE across `summit`. §3 ends "there is no
    // sun and no sky. Anything that reads as a horizon line is wrong"; §8 lists
    // "a visible horizon" as a named failure mode. A field that bright IS a
    // sky, whatever hue it is painted.
    //
    // The fix is not "turn the exposure down" — that is §2's murk failure and
    // it moves the mass down with the background. The background comes down and
    // `light` above comes UP, so the value ORDER inverts: lit rock is now
    // brighter than the void behind it, which is what §1 means by "lit BY
    // OBJECTS and shaped by darkness" and what the reference does everywhere.
    //
    // The hue split is kept — blue-violet above, magenta-violet below — because
    // that is what stops a dark frame reading monochromatic. What changed is
    // only the VALUE, and the ratio between the two came down from ~3.6x to
    // ~2.4x as well: a steep ramp across the dome is a horizon by another name,
    // and the flatter the background the less the eye can find an edge in it.
    zenith: 0x070413,
    horizon: 0x241238,
    deck: 0x0a0718,
    sun: 0x8b5cf6,

    /**
     * THE PAINTED DOME — the one image file the game loads for this theme.
     *
     * CLAUDE.md rule 1's second exception, approved by Ethan 2026-07-26, and
     * the reason it exists is a structural one rather than a convenience. The
     * background architecture used to be baked impostors, and impostors are
     * baked from `voidbackdrop.js`'s GENERATED geometry — extruded n-gon
     * prisms. However many of them you draw, a prism is a prism: Ethan looking
     * at that build said *"honestly the random shapes in the background is very
     * weak hoping the image method will improve it."* He is right. No count of
     * angular blobs becomes a cathedral; a painting of a cathedral already is
     * one.
     *
     * WHAT IT IS AND IS NOT. It is NOT a second opinion about the sky. The
     * background's COLOUR and its whole vertical value ramp still come from
     * `scVoidGradient` in render/skygrad.js — the single evaluation the aerial
     * perspective and `scene.fog` also read. The image contributes only the
     * HIGH-FREQUENCY half: a per-direction multiplier that darkens the gradient
     * where a spire stands and leaves it alone where the void is empty. That is
     * the same division of labour the skyline's cloud deck has with the same
     * gradient, and it is what keeps distance from disagreeing with background
     * (see the header of render/skygrad.js for the bug that rule exists to
     * kill).
     *
     * Because it is a multiplier with a ceiling at `hi` and `hi` is barely
     * above 1, the dome can never render BRIGHTER than the void behind it, and
     * therefore can never re-create the inversion a previous session shipped —
     * background brighter than the mass, every rock a black cutout. Value order
     * is enforced by the arithmetic, not by taste.
     */
    dome: {
      /** Under `public/`, resolved against `import.meta.env.BASE_URL`. */
      url: 'sky/void-dome.png',
      /**
       * Horizontal repeats around the full 360 degrees.
       *
       * 4, judged by eye against the reference. The painting's lead cathedral
       * is about a third of its width, so at 4 repeats (90 degrees per tile) it
       * subtends ~30 degrees — which is what a hero mass subtends in
       * `theme2-void.png`. At 2 the architecture is colossal and reads as a
       * wall a hundred metres away; at 8 the spires are thumbnail-sized and the
       * whole dome reads as patterned wallpaper. The asset is authored to tile
       * horizontally (measured seam: mean left/right edge delta 3.9 of 255).
       */
      repeat: 4,
      /**
       * Elevation, in degrees, of the image's TOP and BOTTOM edge.
       *
       * The tile is square and spans 90 degrees of azimuth, so an undistorted
       * band would be 90 degrees tall. This is 120, a 1.33x vertical stretch,
       * and the stretch is bought deliberately: `fade` below needs 30 degrees
       * at each end to hide the clamp, so a 90 degree band would have almost no
       * un-faded middle left. What the stretch costs is that gothic spires get
       * taller and narrower, which is the direction to be wrong in.
       *
       * Centred slightly BELOW eye level (+58/-62) because §5's camera looks
       * up: the painting's own dense band then lands where the player reads it.
       */
      elTop: 90,
      elBottom: -90,
      /**
       * Degrees over which the modulation fades to nothing past each edge.
       *
       * This is the entire defence against §3's forbidden horizon LINE. Outside
       * the band the image is clamped, so its edge row would repeat forever and
       * print a hard ruled edge across the frame; instead the effect ramps to
       * zero over 30 degrees and the painting dissolves into plain gradient.
       *
       * 30 and not the 22 this started at, and the correction was measured
       * rather than guessed: at 22 the top edge of the band showed as a clean
       * arc across the upper right of `midclimb`. A third of the visible dome
       * is not an edge whatever is on either side of it.
       */
      fade: 9,
      /**
       * The two ends of the painted range, as scalars on the gradient's own
       * anchors — see `scDomeSky` in src/world.js, which is where they are
       * spent. `lo` scales the LOCAL gradient value and makes the silhouettes;
       * `hi` scales the HAZE anchor and makes the open void between them.
       *
       * `hi` at 0.86 is the safety bound, not a taste dial. It is strictly
       * under 1, so the brightest pixel the painting can produce is dimmer than
       * the brightest pixel the background reached before the image existed —
       * the value inversion is unreachable by arithmetic rather than by care.
       *
       * `lo` at 0.22 is where the read comes from. Architecture at infinity is
       * made by removing light, and this is also what finally puts §2's `clip
       * lo` into a frame that measured 0.00-0.01% against a table asking for
       * 2-8%.
       */
      lo: 0.30,
      hi: 0.95,
      /**
       * THE LEVELS WINDOW — the two numbers that decide whether the painting is
       * legible at all, and both are measured off the file rather than picked.
       *
       * `magick void-dome.png -format %[fx:mean],%[fx:standard_deviation]` says
       * 0.091 and 0.042. So the entire image — void, haze, cathedral, spire —
       * lives between roughly 0.03 and 0.20 of the 0..1 range, and everything
       * above that is a handful of magenta glints. A tone curve that treats the
       * file as though it used its whole range spreads a sixth of the range
       * across a fifth of the output, which is what the first build did: the
       * dome rendered as a faintly mottled dark field, technically present and
       * carrying no architecture. These two expand the painting's own range
       * instead.
       *
       * Raising `white` flattens the dome toward silhouette-only; lowering it
       * blows the haze out and starts to read as a lit sky, which §3 forbids.
       */
      black: 0.03,
      white: 0.20,
      /**
       * Gamma applied AFTER the window above, so it shapes the midtones rather
       * than rescuing the toe. Above 1 pushes the dome toward its silhouette
       * end, which is the direction that keeps a background background.
       */
      gamma: 0.95,
    },
  },
  skyRadius: 900,

  // Nearly 3x skyline's. The depth read in the reference is carried entirely
  // by aerial perspective toward violet, and it is also what makes a fall read
  // as bottomless without modelling a bottom. Note this is the FALLBACK path
  // only (see the block comment in world.js); `aerial` below is the one that
  // actually draws the depth bands.
  fog: { density: 0.0082, color: 0x1c0e30 },

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
    // THE COLOUR OF THE LIGHT IN THE AIR. Measured: with the Fresnel rim below
    // on, a lit void rock face rendered rgb(104,69,61) — bronze; with the rim
    // at zero the SAME face was rgb(1.0, 0.9, 7.1). So this haze colour was
    // supplying essentially all the light landing on the void's mass, and
    // supplying it golden-hour cream. It is why near-black violet rock kept
    // photographing tan whatever the painter did, and it is the single largest
    // remaining difference from the reference image.
    //
    // Cold violet, and dimmer: the void's light comes from crystals and sigils,
    // not from the air.
    //
    // THAT MEASUREMENT NO LONGER HOLDS, and this note is here so nobody spends
    // an afternoon on these two the way this lane did. Re-measured 2026-07-26
    // against the current pipeline: `hazeGain` 0.85 -> 0.58 and `ambUp`
    // 0x9b6bd8 -> 0xffffff (pure white, deliberately absurd, as a probe) each
    // changed the void shot set by less than half a code value. Whatever path
    // once let this colour light the mass, the mass is now lit by `light`
    // above and by the sky IBL. These still set the colour distance FADES
    // toward, which is real and is why they stay violet; they are not a light.
    hazeSun: 0xa871f0,
    hazeGain: 0.58,
    // Ambient hemisphere, matched to the same decision. Violet from above,
    // deep indigo from below — the inverse of the skyline's warm ground bounce.
    ambUp: 0x7a52b0,
    ambDown: 0x2a1f4a,
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

  /**
   * THE GRAPPLE, +50% REACH — a partial overlay over the shipped tuning, in the
   * exact shape `grade`/`exposure`/`aerial` use: a small object the consumer
   * (here `src/player.js`) reads and applies ON TOP of `BASE_TUNING`, never a
   * second copy of the table and never a mutation of the base.
   *
   * Ethan, 2026-07-27, playing the Underworld: "void mode should have a range
   * increase maybe 50% higher than current (skyline default)". So the cuff's
   * aim/latch reach becomes 34 * 1.5 = 51 m in this theme; skyline leaves
   * `grapple: null` and keeps the shipped 34.
   *
   * WHY A SCALE AND NOT A NUMBER. `grappleRange: 51` would be a copy of a value
   * derived from the base, and the base is the single source of truth for what
   * "default reach" is — if it ever moves, a hardcoded 51 silently stops being
   * "1.5x default". A scale stays correct through any future retune of the base.
   *
   * WHAT THIS DOES AND DOES NOT TOUCH. It scales the PLAYER's reach only. It is
   * NOT the course's authoring cap: `Archipelago.link` (src/level.js) proves
   * every grapple crossing against its own `GRAPPLE_MAX` (34 m), which is
   * theme-independent and which this lane does not own. So a longer reach makes
   * every crossing the void already authors EASIER to hit — more forgiving aim,
   * more slack for chaining, more of the scenery orbs in range — without
   * licensing a longer authored gap. See the note on `REACH_GRAPPLE` /
   * `CUFF_REACH` in src/levels/void.js, which re-derives its own constants
   * against this overlay.
   */
  grapple: { rangeScale: 1.5 },

  motes: {
    count: 1400,
    // Violet-white, well over 1.0 so they catch the bloom the way dust near a
    // bright emissive actually does.
    color: [1.35, 1.05, 2.10],
    // TALLER, 2026-07-26. The drift box was a flat slab (140 m of vertical
    // against 220 m each way horizontally), so dust hung in a low band and the
    // upper shaft — the part §5 says the camera is always looking INTO — read as
    // empty air. Ethan's standing critique is "not making you feel you are in a
    // vast space"; a vast vertical space is sold by particles receding UP the
    // column, catching the beams and crystals as they go. Squared to 220 so the
    // same 1400 motes span the whole climb the player is looking up through.
    // This redistributes existing points, it does not add light — the frame's
    // value structure (§2) is unchanged; only WHERE the dust sits moves.
    spread: [220, 220, 220],
    // The void has a current, and a stronger one. §4.5: "small debris drifting
    // upward sells 'the void has a current' and reinforces the upward pull."
    // 0.35 was a barely-perceptible seep; at 0.46 the drift reads as motion in a
    // still frame, which is the atmospheric life the reference has and a static
    // dust field does not.
    rise: 0.46,
    // Bound harder to the beams and crystals. See the block comment in
    // world.js: dust with no light on it is invisible, so an even spread in a
    // near-black scene is mostly wasted particles. §4.5 asks for motes "denser
    // near crystals and beams" specifically; 0.70 (from 0.55) pulls more of the
    // budget into the lit lanes, so the dust that IS visible clusters where the
    // reference's does — around the emissive verticals — instead of speckling
    // the dark uniformly. Concentrating the same points cannot lift the frame's
    // mean; it only makes the visible fraction land on the light.
    cluster: 0.70,
  },

  /** §4.4. Off for any theme that does not ask for it. */
  beams: true,

  /**
   * §5, "depth in three bands". ON, and it is the thing that stops the void
   * being a course in front of flat violet fog — see `src/fx/voidbackdrop.js`.
   */
  /**
   * OFF. The geometry bands are deleted in favour of the painted dome.
   *
   * Ethan, three times over, looking at frames: "the random shapes in the
   * background is very weak", "the shapes are eh if you compare to the image",
   * and finally "all these shapes really take you out of it".
   *
   * He is right and it was never fixable by tuning. `voidbackdrop.js` builds
   * its ruins from extruded prisms, so at any density and any distance they
   * read as flat untextured wedges floating in front of the sky — abstract
   * polygons, not architecture. That is the ceiling of generating a backdrop
   * from the shapes this generator can make.
   *
   * The dome (v2) carries the far read instead, and it was prompted for the
   * COURSE's own vocabulary — floating platforms with drip undersides, walls
   * with panel grids, towers with window openings. Honest loss: the near and
   * mid bands parallaxed and a dome cannot. At the distances involved that is
   * a smaller lie than a field of purple triangles.
   *
   * BACK ON, 2026-07-27, but as ARCHITECTURE this time. Ethan, playing the
   * Underworld, asked for the far structures to read as actual connected
   * buildings — "not just, like, random objects pasted in the background" —
   * fewer, bigger, and MORE low-poly. That is a different layer from the prism
   * scatter this comment retired: `VoidCityBackdrop` (src/world.js) builds
   * connected building complexes (shared footing, towers, setbacks, a bridging
   * span, buttresses, stair slabs) and PARALLAXES in FRONT of the dome, which
   * keeps carrying the true-infinity read behind it. Turning this true selects
   * that class; it does not resurrect `voidbackdrop.js`. See the long note on
   * `VoidCityBackdrop` for the whole argument.
   */
  backdrop: true,

  /**
   * AMBIENT OCCLUSION, SIZED TO THE VOID'S ARCHITECTURE — a partial overlay on
   * the shipped radii in render/contact.js, exactly like `grade`/`exposure`.
   *
   * The default set is 0.9 m broad / 0.24 m near, sized to the sunset level's
   * masonry. The void is a class larger — 40 m great walls, 14 m slabs, gaps of
   * tens of metres — so a 0.9 m probe lands almost entirely on surface within a
   * fraction of a metre of the pixel it started on and finds nothing to
   * occlude. MEASURED with tools/aoprobe.mjs on the default radii: turning AO
   * OFF ENTIRELY moved the frame 1-2.6%, and DOUBLING its intensity moved it
   * the same again — the shape of an estimator that is finding no occluders, on
   * which intensity is the wrong knob. The reference image
   * (docs/reference/theme2-void.png) is a large part detailed BECAUSE of its
   * very deep crevice and under-ledge shading; that shading is a mid-scale
   * phenomenon (a platform's dark underside, the recess between two coursed
   * tiers, a slab resting against a wall), metres not centimetres.
   *
   * Both tiers are scaled up by ~4.5x and keep the default's broad:near ratio
   * (~3.7:1), so the two-set design in contact.js is intact — the broad set now
   * draws the under-ledge/between-mass shading and the near set the block-course
   * and stair-nosing creases at void scale, combined with min() as before.
   *
   * `maxScreen` (the uv clamp) is raised in step with the radius, and it is the
   * one that actually binds up close: at any real viewing distance the world
   * radius wants far more screen than the default 0.10/0.075 clamp allowed, so a
   * bigger radius alone would only move the distance at which the term gives up.
   * contact.js's own default comments record this same lesson twice. The perf
   * lane measured the AO taps as nearly free (cutting them saves nothing), so
   * this whole term is being turned UP into headroom that already exists.
   */
  ao: {
    // Broad set. 4.0 m catches the under-ledge and between-mass shading; 0.20 uv
    // lets it reach that at the distances the platforms actually sit. Intensity
    // and bias unchanged from the default — with real occluders now inside the
    // radius, the shipped intensity finds them.
    radius: 4.0,
    maxScreen: 0.20,
    intensity: 2.6,
    bias: 0.16,
    // Near set. 1.1 m is the void's masonry-joint / block-course scale, the
    // fillet the hard 90-degree corners here do not have; 0.15 uv is its clamp
    // raised in the same proportion. Intensity/bias unchanged from the default.
    nearRadius: 1.1,
    nearMaxScreen: 0.15,
    nearIntensity: 3.2,
    nearBias: 0.12,
  },

  grade: {
    // Crushed toe, violet shadows, cold highlights, and saturation pushed
    // hard — a desaturated void reads as grey murk, which is the failure mode
    // art-direction-void.md §8 calls out by name.
    shadowTint: [0.048, -0.008, 0.030],
    highlightTint: [0.016, -0.016, 0.026],
    /**
     * 1.08, DOWN from 1.60 — and this is calibration against the reference
     * file rather than a retreat from §8's "never grey".
     *
     * `docs/reference/theme2-void.png` measures sat 0.704 and mean rgb
     * (58, 37, 111). At 1.60 the build measured 0.88-0.89 with a mean of
     * (55, 19, 136): far MORE saturated than its own target and starved of
     * green, which is what turned every rock face electric royal-blue instead
     * of the reference's violet. §8 names grey murk as the failure mode and
     * this theme had over-corrected past it into a neon one.
     *
     * At 1.08 the set measures 0.77-0.85 with a mean of (57, 24, 116) — still
     * clear of §2's "> 0.45" floor, and the hue now sits between the reference
     * and where it was rather than beyond it.
     */
    saturation: 1.08,
    contrast: 1.52,
    shadowFalloff: 2.80,
    highlightRise: 1.85,
    highlightDesat: 0.03,
    // 0.94, up from the module default of 0.870, and it is a VOID number
    // rather than a taste one. The white point is the input code value that
    // prints as display white; the skyline's is tuned for a sky whose brightest
    // surface is sunlit brass. The void's brightest surfaces are emissives
    // authored at 30-70 — beams, sigil rings and the plaza's rune inlay — so at
    // 0.870 they do not merely clip, they clip across their whole width and the
    // inlay arrives as flat white tape. §2 asks for 0.3-2.5% clipped high,
    // "crystal cores blow, nothing else"; this is the number that lets a core
    // blow while its surround keeps its violet.
    whitePoint: 0.94,

    /**
     * THE GAMUT GUARD, ALL BUT OFF — and this is the change that stops the
     * void's emissives printing as WHITE OBJECTS.
     *
     * The module default pulls any pixel whose max channel passes 0.62 toward
     * its own luminance, by 0.55 at full overshoot. That is exactly right for
     * the skyline, where the thing it is guarding against is one saturated
     * terracotta roof arriving with its red clipped while its luminance sits at
     * 0.4. It is exactly wrong here, because in a void EVERY emissive passes the
     * knee — beams, sigil rings, rune inlay, crystal cores, anchor orbs — and a
     * blue-dominant violet dragged 55% of the way to its own luminance is grey.
     *
     * Measured: the anchor orb at (1370,295) in `midclimb`, authored violet at
     * emissive 0x7a1aff x 2.1, arrived at rgb(211,204,213). Three equal
     * channels. The review read it as A MOON and it was right to — §3 says
     * there is no sun and no sky, and nothing else in the frame was making that
     * shape. The plaza's rune inlay in `summit` was the same failure at another
     * scale: white tape where the reference has a violet rosette.
     *
     * §2 asks for "crystal cores blow, nothing else". A core that blows is a
     * white core inside a violet object; the guard was turning the whole object
     * white instead. The knee also moves up, so the roll-off starts where the
     * shoulder is actually compressing rather than a tenth of a stop early.
     */
    gamutKnee: 0.78,
    gamutDesat: 0.10,
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
    compensation: -0.94,

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

    /**
     * THE ABSOLUTE EXPOSURE CEILING, RAISED — and finding it explains why this
     * theme was so hard to tune.
     *
     * `render/exposure.js` computes `exposure = 2^compensation / (1.2 * 2^EV)`
     * and then clamps the result into [clampLo, clampHi], defaulting to
     * [0.02, 6.0]. With the EV pinned at -3.5 the divisor is 0.106, so the
     * formula reaches 6.0 at a compensation of about -0.65 — and EVERY value
     * above that produced the identical frame. Measured: -0.32 and -0.46 gave
     * byte-identical statistics across all four void shots. The theme's
     * headline dial was dead against its stop, and anyone reaching for it to
     * fix a dark frame would have found it did nothing and concluded the
     * problem was elsewhere. It is the same class of bug as the one the
     * `compensation` comment above records — a knob quietly landing on the
     * floor — one layer further down.
     *
     * The ceiling exists to stop a pathological frame handing the composite a
     * 200x multiplier. 12.0 is one stop of room above where this theme sits, so
     * it still catches a pathology and no longer catches the shipped value.
     * `compensation` above is now the working dial again and is set to the
     * number that reproduces the measured frame rather than to a number the
     * clamp was silently rewriting.
     */
    clampHi: 12.0,
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
      cavity: [0.72, 0.62, 0.80],
      /**
       * The sun-away hemisphere. There is no sun, so this is really "the side
       * the ambient fill does not reach".
       *
       * RAISED ABOVE 1 and un-skewed, 2026-07-26, from (0.78, 0.62, 1.05).
       * Two things were wrong with it and they are separable. VALUE: it was a
       * darkener on the surface class that covers most of a shaft-facing frame,
       * so the shaded side of every ruin sat below the fog it was meant to
       * silhouette against — one of the several ways this theme was
       * dark-on-light. Above 1 the shaded side is still much darker than the
       * lit side (that gradient comes from `light`, not from here) but it is
       * above the background, which is the order §1 asks for.
       *
       * HUE: it was blue-dominant by 35%, applied to an already blue-violet
       * albedo, under a blue-violet key. Three blue multiplications is how a
       * violet cathedral came out royal blue. Near-flat now, and the violet is
       * carried by the albedo and the light rather than restated three times.
       */
      shade: [1.62, 1.46, 1.50],
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
     * GLOWING VEINS AND CRACKS — the thing the reference has that the build did
     * not, and the reason its dark masses read as magical instead of merely
     * dark. Thin magenta and violet fissures threading the rock, brightest deep
     * in the crack and fading at the lips, as though the stone is lit from
     * inside.
     *
     * The mechanism is split three ways and each file owns the part it is
     * qualified to own: `materials/textures.js` `paintGlowVeins` decides WHERE
     * (its own fault network, cutting across the rock's facets), `materials/
     * shader.js` decides HOW IT LIGHTS (an emissive term, unshaded, before the
     * aerial perspective), and this block decides WHETHER AND HOW HARD — which
     * is a statement about a world and therefore belongs in a theme.
     *
     * The skyline names none of this and so compiles none of it.
     *
     * TWO NUMBERS DID THE TUNING, and both are read against §2 rather than
     * against taste:
     *
     *   `vein` is a linear-light multiplier, so it is measured against the
     *   bloom threshold (0.78 on the max channel after exposure) and not
     *   against an albedo scale. Violet #8b5cf6 is blue-dominant, so the blue
     *   channel clips first and the vein blooms violet before it ever goes
     *   white — which is the correct order for §2's "crystal cores blow,
     *   nothing else". The raw rock runs hotter than the carved face because
     *   §4.1 reserves the carved face's light budget for its sigil rings.
     *
     *   `veinRed` is where red starts in the macro field, and it is the number
     *   §3 constrains directly: "red must stay rare — if red is everywhere, the
     *   image loses its focal points". 0.74 leaves red as a handful of
     *   stretches of fault across a whole level rather than a fixed share of
     *   every surface. It should go UP if red ever starts reading as a colour
     *   the rock simply has.
     */
    veins: {
      voidrock: {
        vein: 1.2,
        // §3's violet crystal body. The fissures and the shards are the same
        // light in two states — one still inside the rock, one erupted out of
        // it — and giving them two different violets would say they are not.
        veinColor: 0x8b5cf6,
        veinRedColor: 0xff2d55,
        veinRed: 0.57,
        veinRedWidth: 0.09,
      },
      voidcarved: {
        // Two-thirds of the rock's. A cut face has not fractured as freely, and
        // the deliberate light on a great wall is its sigil ring, not its
        // cracks.
        vein: 0.82,
        veinColor: 0x8b5cf6,
        veinRedColor: 0xff2d55,
        veinRed: 0.63,
        veinRedWidth: 0.09,
      },
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
    beacon: 0x7a3cc8,
    gateHot: 0xff4d7e,
    gateCool: 0x6fd0ff,
    // DEEPER VIOLET, 2026-07-26. The anchor orb is drawn at intensity 2.1 by
    // `levels/void.js`, so at 0xa77dff its core and most of its bloom halo both
    // clipped to white and the review read one of them as A MOON. §3: there is
    // no sun and no sky, and a bright round white disc in the upper frame is
    // both. The signal is unchanged — big, bright, violet — but the halo now
    // stays violet all the way out instead of going white, which is what turned
    // a light into a celestial body. The blue scenery orbs (`cool`) are what it
    // must stay distinguishable from, and they are further away in hue than
    // white ever was.
    lantern: 0x5c18c0,
    rune: 0x40208f,
    sigil: 0xff2d55,
    cool: 0x3b82f6,
    // Cold and dim: wind streaks are the air, and this air is violet.
    streak: 0x9d7dff,
    streakOverlay: 0xb69cff,
    // A third strength. The void reads on a few deliberate verticals; a
    // full-strength streak field competes with them for the same channel.
    streakGain: 0.34,
  },

  /**
   * The soundscape, as a partial overlay exactly like `grade` / `exposure` /
   * `aerial`. `skyline` deliberately states NOTHING here — that is what makes
   * its audio provably unchanged (measured: RMS delta exactly 0 across all
   * seven skyline cues).
   *
   * Lives in its own file because it is ~120 lines with its rationale and
   * theme.js is already long. See src/audio/void.js.
   */
  audio: VOID_AUDIO,

  /** Its own score — see the commit that generated these. */
  music: 'audio/void/',

  foliage: false,
}

export const THEMES = { skyline, void: voidTheme }
export const DEFAULT_THEME = 'skyline'

/**
 * URL/localStorage name aliases → canonical theme key.
 *
 * The void level is LABELLED "The Underworld" but its identifier stays `void`
 * (see `voidTheme.label`). `?theme=underworld` is offered as a courtesy alias
 * so the name a player now sees also works in the URL — it is an ALIAS, not a
 * replacement: `?theme=void` remains the canonical address and every bookmark
 * keeps working. Kept OUT of `THEMES` deliberately so anything iterating the
 * descriptors for a menu sees one void entry, not two.
 */
const THEME_ALIASES = { underworld: 'void' }

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
  const resolve = (n) => (n && THEME_ALIASES[n]) || n
  if (name && THEMES[resolve(name)]) { active = THEMES[resolve(name)]; return active }
  let want = null
  try {
    want = new URLSearchParams(location.search).get('theme')
      || new URLSearchParams(location.search).get('level')
  } catch { /* no location (harness/node) */ }
  if (!want) {
    try { want = localStorage.getItem('skyline-courier:theme') } catch { /* private mode */ }
  }
  active = THEMES[resolve(want)] || THEMES[DEFAULT_THEME]
  return active
}

export function getTheme() { return active }

/** Convenience for the places that want a THREE type rather than a triple. */
export function themeSunDir(t = active) {
  return new THREE.Vector3(t.sunDir[0], t.sunDir[1], t.sunDir[2]).normalize()
}
