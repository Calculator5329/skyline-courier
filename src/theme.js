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

  motes: {
    count: 900,
    color: [1.0, 0.94, 0.80],
    // Drift box, relative to the player. Kept as the shipped literals.
    spread: [260, 90, 260],
    rise: 0.0,
  },

  // null = the module default GRADE / exposure limits.
  grade: null,
  exposure: null,

  // The surface kinds an island reaches for. `drumPlatform` already takes
  // these per call; a theme names the DEFAULTS so a level does not have to.
  surfaces: {
    built: { capKind: 'porcelain', rimKind: 'terracotta', kind: 'stone', boulderKind: 'stone' },
    wild: { capKind: 'moss', rimKind: 'terracotta', kind: 'stone', boulderKind: 'stone' },
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
 * 2. THE EXPOSURE CLAMP HAS TO MOVE. `exposure.js` clamps minEV at -2.0 with
 *    the comment "this level is one outdoor daylight condition". A void meters
 *    far below that, pins against the floor and stops adapting — the frame
 *    then reads exactly as dark as the clamp allows and no darker. Widening
 *    the window is the single change without which the whole theme washes out.
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
    hemiSky: 0x6b4fa8, hemiGround: 0x1a1430, hemiIntensity: 0.55,
    // A tenth of skyline's key. The crystals are the light in this world.
    keyColor: 0x9b7bff, keyIntensity: 0.35,
    // Cold magenta rim from the opposite side, so silhouettes separate from
    // the fog instead of dissolving into it. art-direction-void.md §5:
    // "dark mass reads only when backed by something brighter".
    fillColor: 0xff3d6e, fillIntensity: 0.30, fillPos: [-40, 12, 36],
    bounceColor: 0x3b82f6, bounceIntensity: 0.22,
  },

  sky: {
    // Not a sky — the far wall of a cavern. Zenith is near-black; the
    // "horizon" is the violet fog the ruins recede into, and there must be no
    // readable horizon LINE (art-direction-void.md §3).
    zenith: 0x0a0714,
    horizon: 0x4c3a7a,
    deck: 0x241a42,
    sun: 0x8b5cf6,
  },
  skyRadius: 900,

  // Nearly 3x skyline's. The depth read in the reference is carried entirely
  // by aerial perspective toward violet, and it is also what makes a fall read
  // as bottomless without modelling a bottom.
  fog: { density: 0.0082, color: 0x3a2b5e },

  motes: {
    count: 1400,
    // Violet-white, well over 1.0 so they catch the bloom the way dust near a
    // bright emissive actually does.
    color: [1.35, 1.05, 2.10],
    spread: [220, 140, 220],
    // The void has a current. Slow upward drift reinforces the climb.
    rise: 0.35,
  },

  grade: {
    // Crushed toe, violet shadows, cold highlights, and saturation pushed
    // hard — a desaturated void reads as grey murk, which is the failure mode
    // art-direction-void.md §8 calls out by name.
    shadowTint: [0.020, -0.006, 0.052],
    highlightTint: [0.010, -0.014, 0.030],
    saturation: 1.46,
    contrast: 1.52,
    shadowFalloff: 2.30,
    highlightRise: 1.85,
    highlightDesat: 0.03,
  },

  exposure: {
    // See note 2 above. Without this the theme cannot get dark.
    minEV: -7.0,
    maxEV: 5.0,
    compensation: -0.35,
    // The void's "sky" is the DARKEST part of the frame, not the brightest, so
    // the horizon bias that exists to reject a blown sky is backwards here.
    skyWeight: 0.05,
    horizonBias: 0.0,
  },

  surfaces: {
    built: { capKind: 'stone', rimKind: 'stone', kind: 'stone', boulderKind: 'stone' },
    wild: { capKind: 'stone', rimKind: 'stone', kind: 'stone', boulderKind: 'stone' },
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
