import * as THREE from 'three'
import { extendSurfaceMaterial, setGroundLevels } from './materials/shader.js'
import { surfaceTextures } from './materials/textures.js'

/**
 * Every surface in the game is generated here. No image files, ever.
 *
 * The world is a clockwork sky-garden archipelago floating over a sea of golden
 * sunset cloud: warm carved sandstone, ornate machined brass, lush saturated
 * moss, and cooler green-grey boulder rock underneath the islands. Polished
 * stylised film, not photoreal and never grey.
 *
 * Three layers do the work, and they answer three different failures:
 *
 *   A. THE TILE (materials/textures.js). Canvas textures painted at load,
 *      carrying detail below ~2 m as FOUR channels — albedo, height, roughness
 *      and metalness — plus a derived cavity. Painting all the form into albedo
 *      is what made brass read as varnished pine; see that file's header.
 *   B. THE MACRO LAYER (materials/shader.js). Everything ABOVE the size of a
 *      tile — relief that tilts the shading normal so flat slabs catch the sun
 *      in ridges, two bands of albedo/roughness drift, moss creeping out of
 *      every wall/floor junction, sun-bleach on upward faces, de-tiling, the
 *      sun aureole in the specular chain, and the cool tint in every recess.
 *   C. THE PALETTE (here). Which is not decoration: brass means "wall-run me"
 *      and terracotta means "wall", so if those two sit 18 degrees apart in hue
 *      the level is lying to the player. They now sit ~30 apart.
 *
 * Plus, from level.js: world-consistent texel density (0.42 repeats/metre), and
 * per-box tint jitter with baked contact shading in the vertex colours. This
 * file never touches those channels.
 */

export const PALETTE = {
  // Warm carved sandstone. Sandy/peach and deliberately NOT a pale cream: at
  // golden hour a cream surface goes white. Desaturated from 0xe7d3ac at the
  // same value — sandstone is the largest area in almost every frame, so it is
  // the biggest single contributor to the measured "84% of pixels inside one
  // 20-degree hue bin", and the cheapest thing it can do is shout less.
  porcelain: 0xe8d2b0,
  /**
   * The signature material, and the wall-run affordance.
   *
   * A GREEN-gold, not a red-gold: green channel essentially equal to red. This
   * is not the colour real brass is, it is the colour an F0 has to be for the
   * REFLECTION to land in the gold band, because the sun and sky arrive with
   * green at ~0.6 of red and blue at ~0.2 and multiply every surface down
   * toward orange. The measured failure was brass and sandstone both landing at
   * hue 30 in closeup.png — the shot whose entire job is to argue one against
   * the other. See materials/textures.js `brass` for the arithmetic.
   */
  brass: 0xd7bf44,
  /**
   * Lush and saturated, and a full hue wedge greener than the old 0x4a7a36.
   * The review measured the moss deck at value 0.17 / hue 62 (khaki) against
   * sandstone at 0.44 two metres below it. Half the fix is here — linear green
   * up from 0.19 to 0.40 — and half is the wrapped-diffuse term in
   * materials/shader.js, because a horizontal surface under a sun at 10 degrees
   * elevation gets almost no direct light by cosine law no matter how bright
   * its albedo is.
   */
  moss: 0x62a44f,
  /**
   * Sandy peach and ochre — the brief's words — at hue 23 and saturation 0.59.
   *
   * Was 0xc34a26: hue 14 at 0.80 saturation, which the grade's 1.30 saturation
   * multiplied into a measured hue 17.4 / saturation 0.81 on the underpass
   * slab. That is a safety cone, and it is the entire mid-mass of that frame
   * plus the rim of every island in the archipelago.
   *
   * It is still ~17 degrees off brass, so the reserved-accent contract holds:
   * terracotta means the route acts here, and it still cannot be mistaken for
   * gold. See materials/textures.js `terracotta` for the rest of the argument.
   */
  terracotta: 0xc0764e,
  /**
   * The boulder rock under the islands, and — via level.js — a good deal of the
   * paving. The one surface allowed to be genuinely cool, and the counterweight
   * to the warm masonry.
   *
   * 0x8e968b sat at hue 96, and hue 96 is the OLIVE corner: the grade
   * multiplies saturation by 1.30 and pushes green into the shadow term, so
   * every amplification this material takes moves it further into khaki. The
   * previous pass tried to solve that by going greener still; it did not work,
   * because the problem was never how much green, it was WHICH green.
   *
   * 0x8c9492 is hue 165 at saturation 0.054 — the same value, a third less
   * saturation, and rotated to the cyan side of green where damp cool rock
   * lives. Still the coolest substance in the palette; no longer able to be
   * amplified into a colour.
   *
   * NOT DONE, AND NOT IN THIS LANE: the roadmap's preferred fix is to stop
   * paving with this kind at all and restrict it to undersides and boulder
   * mass. That is a `level.js`/`kit.js` change (`BUILT`/`WILD` both pass
   * `kind: 'stone'` for the drum body). What the material half can do instead
   * is make the same kind read two ways: `upWarm` below is at 0.70 on stone, so
   * a stone DECK takes the golden-hour sky's warm bias and a stone UNDERSIDE
   * does not.
   */
  stone: 0x8c9492,
  // Golden-hour haze rather than a clear blue zenith.
  sky: 0xe9b57a,
  ink: 0x2b2622,
}

/**
 * Per-kind surfacing.
 *
 * ROUGHNESS AND METALNESS ARE 1.0 HERE ON PURPOSE. Both now come out of the
 * generated ORM texture, and three multiplies the map by the scalar; leaving a
 * scalar in would silently scale a carefully authored map. The real values are
 * in materials/textures.js, per texel, which is where they belong — a rivet
 * crown and the grimy channel it sits in are not the same polish.
 *
 * `depth` is the metres of relief the height field spans, so it is checkable:
 * brass at 0.014 means the tallest gear tooth stands 14 mm off the plate.
 *
 * `relief`, `detile`, `wedge`, `topDust`, `sunLobe`, `cavity`, `glint`, `wrap`,
 * `upWarm`, `patina` and `worldUv` are the knobs that decide how much of the
 * macro layer a material pays for; 0 compiles the feature out entirely.
 * Everything else is documented in materials/shader.js.
 */
/** level.js's TEX_PER_METRE. The world-planar uv path must match it exactly or
 *  the material silently changes texel density relative to every other one. */
const TEX_PER_METRE = 0.42
const SURFACE = {
  porcelain: {
    /**
     * ENV INTENSITY IS THE ONLY AMBIENT KNOB A MATERIAL OWNS, and the art
     * review's finding was that ambient is swamped by the key. skyenv.js
     * normalises the map to 20% of the sun's irradiance; running it at 0.75
     * quietly spent that down to 15%, which is why the cool green zenith it
     * carefully builds never landed on anything. Back up over 1.
     */
    envMapIntensity: 1.30,
    // Carved ashlar: bevelled arrises and chisel tooling over ~4 cm of relief.
    depth: 0.04,
    cavityRadius: 14,
    // 2.8, down from 3.4: the course table widened the joints and deepened the
    // arris chamfers, and cavity is measured against the local mean — so more
    // of the tile now counts as "in a pocket" and the cool-zenith tint that
    // rides on it took the whole deck green. The gain compensates for the
    // geometry change; the tint per unit of pocket is unchanged.
    cavityGain: 2.8,
    // Sandstone is carved and slumped: the strongest relief of the built set,
    // so a 30 m terrace reads as tooled masses rather than one flat plane.
    relief: 1.1,
    reliefAlbedo: 0.16,
    /**
     * DE-TILING IS OFF ON EVERY MATERIAL WITH REGISTERED DETAIL, and that is a
     * deliberate reversal.
     *
     * The de-tile blend samples the ALBEDO a second time at a rotated uv. That
     * was harmless when albedo carried all the detail, because there was
     * nothing for it to disagree with. Now the joints, bevels and tile laps
     * live in the height map too, and de-tiling one and not the other paints a
     * mortar line across the middle of a block — which showed up in the capture
     * as diagonal scars crossing the floor. Registered detail cannot be
     * stochastically offset unless every channel is offset with it, and doing
     * that correctly means rotating the sampled tangent-space normal as well.
     * Until that lands, the two macro bands and level.js's per-box tint jitter
     * carry the anti-repetition load, and those are raised here to compensate.
     */
    detile: 0,
    macroAlbedo: 0.36,
    macroRough: 0.20,
    macroHue: 0.56,
    bigAlbedo: 0.15,
    wedge: 0.9,
    wedgeColor: 0x3f6a2c,
    topDust: 0.42,
    topColor: 0xf2e0ba,
    topRough: 0.16,
    // Dressed sandstone is not glossy, but at golden hour a low sun skims it
    // and the arrises light up. That skim is most of what "carved" looks like.
    sunLobe: 0.30,
    cavity: 0.72,
    // Dielectric: F0 is 4%, so the horizon band comes back as a faint sheen on
    // a wet-looking arris rather than as a bright sweep. Deliberately an order
    // of magnitude under brass — that GAP is the material separation.
    glint: 0.10,
    specAo: 0.60,
    shadeTint: 0.55,
    /**
     * Sandstone is what the player walks on, and the walking deck is the
     * surface the review measured as mint. On the tower stair, tread and riser
     * are the same porcelain 30 cm apart and came back at hue 45.8 against hue
     * 34.1. See scSkyWarmCol in materials/shader.js for why an up-face under a
     * 9.8-degree sun ends up lit almost entirely by the cool zenith, and why
     * biasing it back toward the warm horizon ring is a correction rather than
     * a tint.
     *
     * SIZED AGAINST THE GRADE'S OWN FIX, not against the original measurement.
     * The render lane's shadow-tint split landed in the same round and took the
     * tread from 45.8 to 38.5 on its own; at the 0.90 this was first tuned to,
     * the two corrections stacked and overshot to 31.1, i.e. 4.7 degrees WARMER
     * than the riser. 0.55 lands the tread at ~34 against a riser at ~35.8,
     * which is the actual target: one material, one hue, whichever way it
     * faces. If the grade's split is ever tuned back, this has to come up.
     */
    upWarm: 0.55,
  },
  brass: {
    // Polished metal at golden hour is entirely what it reflects — metalness is
    // 1, so there is no diffuse term at all and the environment is the ONLY
    // thing painting this surface. Over 1 is not a fudge here: skyenv.js
    // normalises its map to 20% of the sun's irradiance for the diffuse chain's
    // sake, and a mirror does not obey that budget.
    envMapIntensity: 3.0,
    // Gear teeth stand 22 mm proud, rivet heads about 14 mm. Chunky for real
    // ironmongery, and chosen for it: the reflection direction turns by TWICE
    // the normal tilt, so relief is the only thing that can put a highlight on
    // a wall the sun does not happen to mirror into. Flat plate cannot sparkle.
    depth: 0.022,
    cavityRadius: 9,
    cavityGain: 3.2,
    // Rolled plate oil-cans slightly; it does not slump like clay. Low, but
    // non-zero — dead-flat metal is the most primitive-looking material there is.
    relief: 0.4,
    reliefAlbedo: 0.06,
    // Off: brass albedo is now almost featureless (everything is in height and
    // roughness), so a second albedo sample buys nothing and costs a fetch.
    detile: 0,
    // Metal varies more in polish than in colour, so the roughness bands carry
    // the variation and the albedo bands stay restrained.
    macroAlbedo: 0.14,
    macroRough: 0.26,
    macroHue: 0.20,
    bigAlbedo: 0.06,
    bigRough: 0.16,
    wedge: 0.85,
    // Verdigris-toward-moss where brass meets a planted deck.
    wedgeColor: 0x4b7440,
    topDust: 0.45,
    topColor: 0xe8cf9a,
    topRough: 0.14,
    // The whole point. Brass is the only material here whose appearance is
    // ~100% reflection, so it takes the strongest sun lobe by a wide margin.
    sunLobe: 0.85,
    /**
     * The horizon glint, and the single biggest change to this material.
     *
     * The sun lobe above only fires on faces that mirror the sun; every other
     * brass face had nothing sharp in the environment to reflect, which is why
     * a 200x200 patch of "polished brass" in crossing.png spanned 24 luma. 1.5
     * is high on purpose: this is the term that has to carry a metal wall from
     * every angle the sun lobe does not, and a wall-run's directional parallax
     * comes entirely out of watching this band sweep along the plate.
     *
     * 1.15 rather than the 1.5 it was first tuned at: at 1.5 the brass
     * balustrades in underpass.png took the frame's clipped-high fraction from
     * 0.2% to 2.8%, and a blown highlight carries no shape. The sweep is
     * unchanged in kind, only in peak.
     */
    glint: 1.15,
    cavity: 0.55,
    // Strong: on a material whose diffuse term is zero by construction, killing
    // reflected radiance in the pockets is the ONLY way to get a dark end, and
    // without a dark end there is no "polished golden highs with darker
    // recesses" — just an evenly bright orange plane.
    specAo: 0.80,
    // Brass in shadow goes green-gold, not red — that is the classic look of
    // the alloy and it is also what keeps a sun-away brass wall from landing on
    // top of terracotta's hue, which is the legibility failure the review named.
    shadeTint: 0.45,
    // The lowest non-zero in the set: brass albedo IS its F0, and pushing an
    // F0 around is a different claim from warming a diffuse colour — at 0.25
    // the correction walked the F0's own hue 6 degrees, which is a fifth of the
    // gap that separates brass from terracotta. Enough that a brass tread
    // agrees with the sandstone beside it, and no more.
    upWarm: 0.12,
    /**
     * VERDIGRIS ON THE DOWNWARD FACES, and the last of the three things a
     * full-screen brass wall was measured to be missing.
     *
     * The tile's own verdigris pass is driven by the cavity of the height field
     * and is correct as far as it goes — it puts crust in the gear-tooth roots
     * and the rivet channels. What it cannot know is which way the BOX faces,
     * and copper carbonate is overwhelmingly an underside phenomenon: the
     * soffit of a band, the lee of a bracket, the shadowed half of a boss.
     * Measured on `closeup.png`, every brass region in the frame sat inside 1.9
     * degrees of hue — there was not one cool pixel on the signature material.
     *
     * 0.40 with a 0.55 hard cap in the shader: a patina is a film, and the
     * plate must still read through it.
     */
    patina: 0.40,
    patinaCavity: 0.30,
  },
  moss: {
    envMapIntensity: 1.05,
    // Moss caps are genuinely lumpy: 6 cm between a clump crown and the damp
    // hollow beside it, which is what makes a landing pad read as soft.
    depth: 0.06,
    cavityRadius: 12,
    cavityGain: 3.0,
    // The thickest relief in the set: moss caps sit on stone as mounds with an
    // overhanging lip, and the tilt is what sells that at platform scale.
    relief: 1.25,
    reliefAlbedo: 0.22,
    // Kept: moss has no registered detail, only soft organic clumps, so an
    // offset albedo sample reads as more clumping rather than as a misprint.
    detile: 0.95,
    /**
     * WORLD-PLANAR UV. A moss cap is assembled from several boxes and each one
     * brings its own uv origin, so the mat stepped at every box join — the
     * review found exactly that seam across the top of the gaps deck. Sampling
     * off the world position makes the whole cap one continuous mat.
     *
     * Moss is the only material that takes this: everything else has registered
     * detail (ashlar courses, roof laps, brass bands) that must stay keyed to
     * the box it was laid out on.
     */
    worldUv: TEX_PER_METRE,
    /**
     * WRAPPED DIFFUSE. See WRAP in materials/shader.js. The sun sits at 9.8
     * degrees elevation, so a flat moss deck facing straight up collects
     * cos(80) = 0.17 of the key by Lambert and the review measured the result
     * at value 0.17 against sandstone's 0.44. At w = 0.4 that direct term goes
     * to 0.41 — foliage is translucent and genuinely does pick up light well
     * past its terminator, so this is a correction, not a cheat.
     */
    wrapWidth: 0.40,
    wrap: 0.85,
    // Back-lit transmission on the overhanging lip. A cap edge against the void
    // with the sun behind it glows, and it is the most recognisable vegetation
    // cue in the reference art.
    backlit: 0.55,
    // 0.40, up from 0.34: band 1 runs at 1-4 m, which is exactly the scale the
    // review found missing on a 12 m disc, and the tile's new clump mask covers
    // only 0.6-1.2 m. `mix(1, 0.62 + 0.80 * macro, 0.40)` spans 0.85..1.17.
    // Not the 0.44 first tried: at that amount the band read as smeared sweeps
    // across the deck rather than as clumping, because it is a smooth fbm and
    // the tile mask is what carries the organic edge.
    macroAlbedo: 0.40,
    macroRough: 0.12,
    macroHue: 0.50,
    bigAlbedo: 0.13,
    // Moss on moss: the corner just goes deeper and damper.
    wedge: 0.35,
    wedgeColor: 0x2f5222,
    // Sun-bleached tips on the upward faces, which is where the light lands.
    topDust: 0.28,
    topColor: 0xa8c06a,
    topRough: 0.10,
    // Wet moss does catch a sheen, and a landing pad that reads wet reads soft.
    sunLobe: 0.16,
    cavity: 0.55,
    // Moss is already the cool end of the palette; pushing it further just
    // turns a landing pad grey, and a landing pad has to stay legible.
    shadeTint: 0.30,
    // A moss cap DOES catch the horizon ring — it is why the reference's turf
    // reads golden at the rim — but this material's job is to be the cool half
    // of the palette, and a warm bias at porcelain's strength would walk it
    // straight back to the khaki the last round fixed.
    upWarm: 0.14,
  },
  terracotta: {
    envMapIntensity: 1.25,
    // Lapped roof tiles: 3 cm from crown to lap.
    depth: 0.03,
    cavityRadius: 12,
    cavityGain: 3.2,
    relief: 0.75,
    reliefAlbedo: 0.13,
    // Off for the same reason as porcelain: the lap between two tiles is
    // registered detail and cannot be offset in albedo alone.
    detile: 0,
    macroAlbedo: 0.34,
    macroRough: 0.20,
    macroHue: 0.48,
    bigAlbedo: 0.16,
    wedge: 0.95,
    wedgeColor: 0x44662c,
    topDust: 0.50,
    topColor: 0xecd2a6,
    topRough: 0.18,
    // A fired glaze is the second-shiniest thing in the world after brass.
    sunLobe: 0.34,
    // A glaze is still a dielectric, so the band comes back as a wet sheen on
    // the tile crowns rather than as brass's sweep.
    glint: 0.22,
    cavity: 0.80,
    // 0.58, down from 0.70. That number was sized against a hue-14 base at 0.80
    // saturation, where a cool shadow was the only thing keeping the material
    // off the "one orange wedge" complaint. The base is now hue 23 at 0.59 and
    // does not need to be argued down that hard — at 0.70 the desaturated tile
    // went grey-pink on every sun-away face.
    shadeTint: 0.58,
    /**
     * OFF, and the only material in the set that takes none of it.
     *
     * scSkyWarmCol corrects an up face by cutting GREEN — that is the channel
     * measurement said was 19% too high on a sandstone deck. On a red-orange
     * material the same cut walks hue the wrong way: at 0.45 it took the
     * terracotta roofs from hue 22.6 back to 15.8, i.e. straight back to the
     * safety cone this round exists to remove. Terracotta was never the
     * material that read cold on a deck, so it does not need the correction.
     */
    upWarm: 0,
  },
  stone: {
    envMapIntensity: 1.35,
    // Boulders: 9 cm between a cobble crown and the crevice under it. The
    // biggest relief in the set, because this is raw rock, not dressed stone.
    depth: 0.09,
    cavityRadius: 16,
    cavityGain: 3.0,
    relief: 0.95,
    reliefAlbedo: 0.18,
    // Kept, same reasoning as moss: weathered boulders, nothing registered.
    detile: 0.9,
    macroAlbedo: 0.32,
    macroRough: 0.14,
    // Less hue drift than the built stone: it should stay cool grey-green and
    // read as the raw rock underneath rather than as more sandstone.
    macroHue: 0.26,
    bigAlbedo: 0.13,
    // Island undersides are where the vines trail off, so this gets the most.
    wedge: 1.0,
    wedgeColor: 0x395c28,
    topDust: 0.55,
    topColor: 0xd8cdb4,
    topRough: 0.20,
    sunLobe: 0.20,
    cavity: 0.68,
    shadeTint: 0.60,
    /**
     * THE HIGHEST IN THE SET, and this is the material half of "stop paving
     * with the grey-green stone".
     *
     * `level.js` hands this kind to the drum body of every island and to the
     * rim of every scenery island, so it is walked on whether it was meant to
     * be or not, and re-pointing that is a level change outside this lane. What
     * the material can do is stop being one substance in two orientations: an
     * up-facing stone deck takes the warm horizon ring at 0.70 and reads as
     * sandy paving, while the underside of the same drum keeps the cool
     * cyan-grey the palette wants under an island. Higher than porcelain's 0.55
     * because this kind starts 60 hue degrees greener and has further to come.
     */
    upWarm: 0.70,
  },
}

const _cache = new Map()

export function surfaceMaterial(kind) {
  if (_cache.has(kind)) return _cache.get(kind)

  const s = SURFACE[kind]
  if (!s) throw new Error(`unknown surface kind: ${kind}`)

  const { map, normalMap, ormMap } = surfaceTextures(kind, {
    depth: s.depth,
    cavityRadius: s.cavityRadius,
    cavityGain: s.cavityGain,
  })

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    // Same texture in both slots: three reads roughness from G and metalness
    // from B, so one canvas and one sampler serve both.
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    // See the SURFACE header — the maps are absolute, not modulations.
    roughness: 1.0,
    metalness: 1.0,
    vertexColors: true,
    envMapIntensity: s.envMapIntensity,
  })
  // 1,1 is "use the map as authored". textures.js already states the relief in
  // metres, so exaggerating it here would make that statement a lie.
  mat.normalScale.set(1, 1)
  mat.name = `surface:${kind}`
  extendSurfaceMaterial(mat, s)

  _cache.set(kind, mat)
  return mat
}

/** Emissive material for the lanterns and the finish bell. */
export function glowMaterial(color, intensity = 1.4) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0.1,
  })
}

/**
 * Tell the moss-creep wedge which world-Y planes count as floors (max four).
 * Defaults cover the course as built; see materials/shader.js.
 */
export { setGroundLevels }
