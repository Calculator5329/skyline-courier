import * as THREE from 'three'
import { SKY_GRADIENT_GLSL } from '../render/skygrad.js'

/**
 * THE FAR BANDS — `docs/art-direction-void.md` §5, "depth in three bands".
 *
 * The complaint this file answers, from Ethan looking at the build beside the
 * reference: **beyond the course there is flat violet fog.** The reference is
 * vast — layer on layer of ruins, spires and floating fragments receding into
 * haze, most of it far too distant to ever reach. §5 is explicit that "if
 * everything sits in one band the space collapses", and until this the void
 * had exactly one band: the course, and then nothing.
 *
 * FOUR THINGS THIS FILE IS TRYING TO GET RIGHT, in the order they matter.
 *
 * 1. IT IS UNREACHABLE, AND THAT IS MEASURED. Every instance carries no
 *    collider — it is never handed to `Level.solid()`/`decor()` and never
 *    enters the collision world — and on top of that `assertClear()` below
 *    measures the closest approach of any instance to the play volume and
 *    THROWS under `CLEARANCE` metres. `Archipelago.sceneryAt()` enforces the
 *    same 70 m rule on the sunset level's ghost islands; the void course is
 *    built by a file this lane does not own, so the check is done here against
 *    the course's own published extents instead. taste.md's rule is the real
 *    one: scenery must never impersonate a surface you can land on. Nothing
 *    here is within a grapple, a dash and a fall of anything solid.
 *
 * 2. THE BANDS ARE THREE, AND THEY ARE DISTANCES, NOT DECORATION. Near
 *    backdrop (280-550 m) still resolves a silhouette with facets in it and
 *    reads DARKER than the dome; mid (480-880 m) sits at almost exactly the
 *    dome's own value and reads as shape without value; far (740-1040 m) is
 *    LIGHTER than the dome — a stain a shade off the fog. Those three ratios
 *    (0.74 / 1.05 / 1.26) are authored per band in `BANDS` and they are the
 *    whole mechanism; see the note on `makeMaterial`.
 *    The extinction that separates them runs in this file's own shader — see
 *    the note on `uHaze` for why the scene's height-integrated aerial
 *    perspective is the wrong model at this range — but the colour it fades
 *    INTO is `scVoidGradient` from `render/skygrad.js`, the same single
 *    evaluation the dome and the aerial perspective use. A backdrop that faded
 *    to its own private violet would be the "distant geometry terminates
 *    against a colour the sky never reaches" bug that file was written to kill.
 *
 * 3. IT IS BACKDROP, SO IT COSTS BACKDROP MONEY. Three InstancedMeshes, one
 *    per band, three draw calls and under 9k triangles for the whole layer —
 *    against a course that is already 11-12k. LOD is by band and is decided at
 *    build time rather than per frame: a thing that can never be approached
 *    can never need a closer mesh, so the far band is simply authored with the
 *    cheap geometry. No runtime switch, no popping, no per-frame traverse.
 *
 * 4. NOTHING IS HARDCODED VIOLET. Every colour is read off the theme
 *    descriptor (`src/theme.js`) — dome zenith and haze for the inscatter,
 *    hemisphere sky/ground for the mass, the fill for the rim. Switch the
 *    theme's palette and the backdrop follows it.
 */

/**
 * THE PLAY VOLUME, as published data.
 *
 * Read off `src/levels/void.js` — which this lane does not own and must not
 * edit — by evaluating its own spiral rather than by eyeballing a shot:
 *
 *   hero islands   r 32 .. 142, y 5 .. 496, half-width up to 14 m
 *   great walls    r + 16, 26 m deep  ->  outer face at r + 29
 *   spire          (38.3, 507.0, -75.0)
 *   plaza          26 m square at the origin
 *   kill plane     y = -180
 *
 * So a cylinder of radius 185 m spanning y -180 .. 545 contains every solid
 * surface in the level with room to spare.
 *
 * UPDATED 2026-07-26: the course grew from 29 islands to 51 — radius 92 -> 142,
 * finish 232 m -> 508 m. These numbers were still describing the old course,
 * which is exactly the quiet failure the comment below warns about: the
 * clearance assertion was measuring against a play volume that no longer
 * existed, so it could have passed while scenery sat inside the level. `tools/shots.mjs` already quotes
 * void.js coordinates by the same convention ("read off at build time, not
 * invented"); this is that convention applied to the extents.
 *
 * If void.js grows again, this is the one block to update — and `assertClear()`
 * will fail loudly rather than quietly shipping reachable scenery.
 */
export const VOID_PLAY_VOLUME = { radius: 185, minY: -180, maxY: 545 }

/**
 * The same 70 m `Archipelago.verify()` demands of the sunset level's ghost
 * islands: the grapple sphere (34 m) plus a committed dash off its far side
 * plus slack. Doubled here to 140 m, because it is free — nothing in this
 * layer is meant to be near — and because the value of a far band is that it
 * is unmistakably far.
 */
export const CLEARANCE = 140

/** Deterministic, for the same reason `voidBeamSites()` is: shots must repeat. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * ONE ARCHETYPE, SCALED INTO EVERYTHING.
 *
 * A tapered n-gon prism with a broken point hanging under it: the silhouette
 * of a floating ruin. Squat and wide it is a ruin mass; narrow and 200 m tall
 * it is a spire; 4 m across it is a drifting fragment. That is deliberate and
 * it is what keeps this to three draw calls — a mesh per silhouette family
 * would have been a draw call per family per band.
 *
 * At 200-900 m the difference between an authored ruin and a scaled prism is
 * a handful of pixels of profile, and the profile is the entire read: §5 asks
 * for "silhouetted ruin masses, spires and drifting fragments", and a
 * silhouette is exactly the thing a low-poly proxy gets right.
 *
 * The per-side radius jitter is baked into the geometry rather than applied
 * per instance in the vertex shader, because jittering a vertex invalidates
 * the flat normal computed for its face — and flat, hard-broken normals are
 * what stop these reading as smooth blobs. Variety across instances comes from
 * non-uniform scale and yaw instead, which are free and normal-safe.
 *
 * Non-indexed so `computeVertexNormals()` produces one normal per FACE.
 *
 * @param {number} sides   how many faces around; the LOD dial
 * @param {number} seed
 */
function ruinGeometry(sides, seed, apex = 0.85) {
  const rand = rng(seed)
  // Base ring at y = 0, top ring at y = 1, broken apex below at y = -apex.
  // `apex` is the LOD/shape dial as much as `sides` is: at 0.85 the underside
  // is a long spike and the whole thing reads as a crystal shard, which is
  // wrong twice over — §4.3's crystals belong to another lane and are a
  // different element, and a field of shards is not "ruins". The bands run it
  // at 0.35-0.45, which is a broken plinth under a plateau.
  // The body is authored 1 m tall and 1 m across so an instance's scale IS its
  // size in metres, which is what makes the placement code below readable.
  const baseR = [], topR = [], ang = []
  for (let i = 0; i < sides; i++) {
    ang.push((i / sides) * Math.PI * 2)
    baseR.push(0.5 * (0.72 + rand() * 0.56))
    // The top ring keeps MOST of the base radius. A hard taper to 0.4 was the
    // last of the crystal read: a strongly tapered prism is a shard whatever
    // its proportions, and a broken tower is a column that has lost its top.
    topR.push(0.5 * (0.55 + rand() * 0.34))
  }
  // Ruin tops are broken, not milled flat: a small per-corner height wobble on
  // the top ring is most of what stops a field of these reading as a bar chart.
  const topY = []
  for (let i = 0; i < sides; i++) topY.push(1 - rand() * 0.34)
  // The cap's centre vertex sits at the MEAN of the ring, not at the maximum.
  // Pinning it to 1.0 built a little peak over every mass and turned the whole
  // layer into a crystal field — the one silhouette this element must not have,
  // because §4.3's crystals are a different element owned by a different lane.
  const capY = topY.reduce((a, b) => a + b, 0) / sides

  const pos = []
  const P = (i, ring) => {
    if (ring === 'apex') return [0, -apex, 0]
    if (ring === 'centre') return [0, capY, 0]
    const a = ang[i % sides]
    const r = ring === 'base' ? baseR[i % sides] : topR[i % sides]
    const y = ring === 'base' ? 0 : topY[i % sides]
    return [Math.cos(a) * r, y, Math.sin(a) * r]
  }
  const tri = (a, b, c) => { pos.push(...a, ...b, ...c) }

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    const b0 = P(i, 'base'), b1 = P(j, 'base')
    const t0 = P(i, 'top'), t1 = P(j, 'top')
    // Sides, wound CCW seen from outside.
    tri(b0, b1, t1)
    tri(b0, t1, t0)
    // Top cap, fanned from the centre.
    tri(t0, t1, P(0, 'centre'))
    // The broken underside: a cone down to a point. §4.2 — "the underside is
    // the opposite: jagged broken rock". At this range one apex is enough.
    tri(b1, b0, P(0, 'apex'))
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

const VERT = /* glsl */`
  attribute float aSeed;
  attribute float aDrift;   // metres of vertical wander; 0 for the big masses
  uniform float uTime;
  varying vec3 vNormalW;
  varying float vDist;
  varying vec3 vDirW;
  varying float vSeed;

  void main() {
    // instanceMatrix / USE_INSTANCING is declared by three's own vertex prefix
    // for ShaderMaterial (not for RawShaderMaterial) — this is the supported
    // path, not a trick.
    vec4 world = instanceMatrix * vec4(position, 1.0);

    // §4.5: "small debris drifting upward sells 'the void has a current'".
    // Only the fragments carry a non-zero aDrift; a 300 m ruin mass that
    // bobbed would read as an earthquake.
    world.y += sin(uTime * 0.07 + aSeed * 6.2831) * aDrift;
    world.x += cos(uTime * 0.05 + aSeed * 4.1) * aDrift * 0.4;

    // The normal only needs the instance's rotation and scale. Non-uniform
    // scale would strictly want the inverse transpose; the scales here are
    // gentle enough (never more than ~4:1) that the error is a few degrees of
    // shading on an object that is 90% haze by the time it is seen.
    vNormalW = normalize(mat3(instanceMatrix) * normal);

    vec3 toCam = cameraPosition - world.xyz;
    vDist = length(toCam);
    vDirW = -toCam / max(vDist, 1e-4);
    vSeed = aSeed;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const FRAG = /* glsl */`
  ${SKY_GRADIENT_GLSL}

  uniform vec3 uZenith;      // theme.sky.zenith
  uniform vec3 uHaze;        // theme.sky.horizon — what everything fades into
  uniform vec3 uSkyTint;     // theme.light.hemiSky
  uniform vec3 uGroundTint;  // theme.light.hemiGround
  uniform vec3 uRimTint;     // theme.light.fillColor
  uniform vec3 uRimDir;
  // x: extinction per metre, y: transmittance floor, z: inscatter gain,
  // w: body brightness.
  uniform vec4 uHazeParams;

  varying vec3 vNormalW;
  varying float vDist;
  varying vec3 vDirW;
  varying float vSeed;

  void main() {
    vec3 N = normalize(vNormalW);

    // --- the mass ----------------------------------------------------------
    // Unlit on purpose. This layer is hundreds of metres out through violet
    // haze; a full lighting solve would be spent almost entirely on light that
    // the extinction below then throws away, and it would put the backdrop on
    // the shadow-casting path for no visible return. What survives at this
    // range is the hemispheric split — tops catching the violet dome,
    // undersides falling to the deep blue below — and that is what this is.
    float up = N.y * 0.5 + 0.5;
    vec3 body = mix(uGroundTint, uSkyTint, up * up) * uHazeParams.w;

    // The cold rim from the fill direction. §5: "dark mass reads only when
    // backed by something brighter", and in a near-black frame the rim is the
    // only thing that keeps one ruin's edge off another's.
    body += uRimTint * pow(max(dot(N, normalize(uRimDir)), 0.0), 5.0) * 0.015;

    // A per-instance value wobble. Without it every mass in a band arrives at
    // the same value and the layer reads as one cut-out with notches in it
    // rather than as many objects at many distances.
    body *= 0.72 + 0.56 * fract(vSeed * 71.317);

    // --- the haze ----------------------------------------------------------
    // The inscatter is scVoidGradient, the SAME function the dome and the
    // aerial perspective evaluate. The gain is above 1: a distant mass in the
    // reference is LIGHTER than the black behind it, because what the eye is
    // seeing out there is lit haze in front of a ruin rather than the ruin. At
    // gain 1.0 the far band converges exactly onto the dome and disappears —
    // measured, and it is the whole difference between a third band and none.
    vec3 inscatter = scVoidGradient(vDirW, uZenith, uHaze) * uHazeParams.z;

    // Plain distance extinction, NOT the scene's height-integrated aerial
    // perspective, and this is a deliberate divergence rather than an
    // oversight. That model's density is scaled by exp(-cameraY / 70 m): it is
    // built for a 250 m-tall course where the player climbing a tower should
    // feel the haze thin. Applied to a backdrop it means the entire far band
    // evaporates the moment the player reaches the spire at y = 231 — which is
    // the one shot ("look back down over everything") that needs it most. A
    // backdrop is a shell around the viewer at a fixed range, so its haze is a
    // function of distance alone.
    float T = max(exp(-vDist * uHazeParams.x), uHazeParams.y);

    gl_FragColor = vec4(body * T + inscatter * (1.0 - T), 1.0);
  }
`

/**
 * One band's worth of instances, as plain data, so the placement is readable
 * and testable separately from the meshes it ends up in.
 *
 * Composition, not scatter. §5 asks for "layer on layer of ruins" — so the
 * masses are drawn in CLUSTERS at a handful of azimuths rather than spread
 * evenly around the ring. An even ring is a wall; a clustered one has gaps you
 * can see between and through, and it is the gaps that read as depth.
 */
function bandInstances(band, rand) {
  const out = []
  for (let c = 0; c < band.clusters; c++) {
    const cAng = (c / band.clusters + rand() * 0.45 / band.clusters) * Math.PI * 2
    const cRad = band.radius[0] + rand() * (band.radius[1] - band.radius[0])
    const cY = band.y[0] + rand() * (band.y[1] - band.y[0])
    const n = band.per[0] + Math.floor(rand() * (band.per[1] - band.per[0] + 1))

    for (let i = 0; i < n; i++) {
      // Spread within a cluster, in the cluster's own frame: wide across the
      // line of sight, deep along it, and tall. A cluster that is a sphere
      // reads as a clump of rocks; one that is a slab reads as a district.
      const a = cAng + (rand() - 0.5) * band.spreadAng
      const r = cRad + (rand() - 0.5) * band.spreadRad
      const y = cY + (rand() - 0.5) * band.spreadY

      // Spires versus masses is one number: how tall the same prism is scaled.
      // §5's verticals belong out here too — a far band of squat blocks has no
      // top-to-bottom line in it and §5 asks every vantage to have one.
      const spire = rand() < band.spireOdds
      const w = band.width[0] + rand() * (band.width[1] - band.width[0])
      const h = spire
        ? w * (2.4 + rand() * 3.4)
        : w * (0.30 + rand() * 0.72)

      out.push({
        x: Math.cos(a) * r,
        y,
        z: Math.sin(a) * r,
        w,
        // Non-uniform footprint: a ruin seen end-on is a different silhouette
        // from the same ruin seen broadside, and that is free variety.
        d: w * (0.55 + rand() * 0.9),
        h,
        yaw: rand() * Math.PI * 2,
        // A few degrees of tilt on the fragments only. A tilted 200 m spire
        // stops being a vertical, and §4.4's note about leaning applies to any
        // tall thing, not only to the beams.
        tilt: band.tilt * (rand() - 0.5),
        drift: band.drift * rand(),
        seed: rand(),
      })
    }
  }
  return out
}

/**
 * THE THREE BANDS.
 *
 * The distances are chosen against `CLEARANCE` first and composition second —
 * band A's inner radius minus its largest instance still has to clear the
 * play cylinder by 140 m, and `assertClear()` proves it rather than trusting
 * this comment.
 *
 * MOVED OUT 2026-07-26, and this is exactly the event the fail-closed check
 * exists for. The course grew from 29 islands to 51 (radius 92 -> 142, finish
 * 232 m -> 508 m); the moment `VOID_PLAY_VOLUME` was corrected to match,
 * `assertClear()` threw at 109.2 m against its 140 m minimum and the level
 * refused to boot. The near band and the fragments were, by then, genuinely
 * inside the level. Every band is further out, and the counts are up roughly
 * 2x with it — Ethan: "we have less depth and detail in the backdrop as well
 * and less overall objects".
 *
 * The far band's outer edge stays bounded by the CAMERA FAR PLANE (1200 m):
 * 1000 m of ring + 58 m of spread + 142 m of course radius = 1200 exactly, so
 * its `spreadRad` came down as its radius went up.
 */
const BANDS = [
  {
    name: 'near',
    // 10-gon: the only band close enough for a facet to be more than a pixel.
    sides: 10, seed: 0x7a1105, apex: 0.45,
    radius: [470, 600], y: [-430, 640],
    clusters: 17, per: [7, 13],
    spreadAng: 0.30, spreadRad: 80, spreadY: 120,
    width: [30, 78], spireOdds: 0.16, tilt: 0.05, drift: 0,
    // THE BRIGHT RUNG, and the direction of the whole ladder REVERSED
    // 2026-07-26. It used to run 0.74 / 1.05 / 1.26 — near band darker than
    // the dome, far band lighter — which is correct only when the dome is the
    // brightest thing in the frame. It no longer is (see `sky` in theme.js):
    // the background is now near-black, so a band DARKER than it is invisible
    // and a band lighter than it by 26% is the flat pale wash the review
    // caught, "55-65% of the frame is uniform bright violet fog".
    //
    // Now the layer is MASS, lit from the same hemisphere as the course, and
    // the ladder runs the way aerial perspective actually runs: near band
    // brightest and most resolved, each further band both dimmer and closer to
    // the (dark) fog it fades into. The inscatter gain never exceeds 1.0 any
    // more, so no band can render brighter than the void behind it.
    haze: [0.0030, 0.05, 0.85, 0.52],
  },
  {
    name: 'mid',
    sides: 8, seed: 0x2c9f31, apex: 0.40,
    radius: [690, 850], y: [-640, 760],
    clusters: 19, per: [8, 15],
    spreadAng: 0.36, spreadRad: 120, spreadY: 170,
    width: [34, 92], spireOdds: 0.28, tilt: 0.04, drift: 0,
    // THE MIDDLE RUNG. Half the near band's brightness and rather more haze:
    // its edges read against the near band in front of it, and it separates
    // from the void behind it by a step small enough that the eye reads it as
    // distance rather than as a second object.
    haze: [0.0020, 0.05, 0.95, 0.30],
  },
  {
    name: 'far',
    // 6-gon. At 700-900 m a 60 m mass is under 80 px tall; ten faces and six
    // are the same picture, and the saving is 40% of the layer's triangles.
    sides: 6, seed: 0x51d7b3, apex: 0.35,
    // The outer edge is bounded by the CAMERA FAR PLANE (1200 m, src/main.js)
    // measured from the far side of the course, not by taste: a band that
    // clips against the frustum's back would appear and disappear as the
    // player crossed the shaft. 780..1000 m of ring plus 92 m of course radius
    // is 1092 m, with 108 m of slack.
    radius: [880, 1000], y: [-900, 880],
    clusters: 24, per: [9, 17],
    spreadAng: 0.42, spreadRad: 58, spreadY: 300,
    // NOTE the y floor above: -820 m. The bands run far BELOW the course as
    // well as above it, and that is the `plunge` shot's whole read — airborne
    // over the shaft looking down, the depth has to keep going. A backdrop
    // that stops at the kill plane makes a bottomless void look like a pit
    // with a lid on the bottom of the frame.
    width: [60, 180], spireOdds: 0.30, tilt: 0.03, drift: 0,
    // THE FAINT RUNG. §5's "washed almost to the fog colour" — but the fog is
    // near-black now, so "washed to it" means this band is barely there, a
    // suggestion of structure at the edge of visibility. That is the correct
    // reading of the reference: past the mid ruins there is depth you can feel
    // and not quite resolve, not a lit backdrop.
    haze: [0.0016, 0.04, 1.00, 0.16],
  },
]

/**
 * The drifting fragments (§5, "floating fragments"; §4.5, "the void has a
 * current"). Folded into the near band's mesh rather than given their own, so
 * they cost instances and not a draw call.
 */
const FRAGMENTS = {
  radius: [440, 560], y: [-380, 560],
  clusters: 26, per: [5, 10],
  spreadAng: 0.30, spreadRad: 70, spreadY: 170,
  width: [2.5, 7.5], spireOdds: 0.18, tilt: 0.9, drift: 7, apex: 0.45,
}

/**
 * Closest approach of any instance to the play volume, in metres.
 *
 * Conservative on purpose: the instance is treated as a sphere around its own
 * centre with the radius of its largest dimension, and the play volume as the
 * solid cylinder in `VOID_PLAY_VOLUME`. Both approximations err toward
 * reporting LESS clearance than there is.
 *
 * @param {{x:number,y:number,z:number,w:number,d:number,h:number}[]} items
 */
export function clearanceOf(items) {
  const V = VOID_PLAY_VOLUME
  let worst = Infinity
  for (const it of items) {
    // The instance's own extent, as an upright box rather than as a sphere.
    // A sphere around the centre was the first version and it is useless here:
    // this layer's spires are 8x taller than they are wide, so their bounding
    // sphere is mostly empty air and the measurement came back at 56 m for a
    // set whose real closest approach was over 190. A check that cries wolf
    // gets its threshold lowered, which is how a fail-closed gate turns into a
    // decoration.
    const rad = Math.max(it.w, it.d) * 0.5 + (it.drift || 0)
    // The prism is authored with its base at y = 0 and its top at y = 1; its
    // broken point hangs at -apex, which no band runs deeper than 0.85. Using
    // the deepest possible value here rather than the band's own keeps this
    // measurement conservative, which is the only direction a safety check may
    // ever be wrong in.
    const y0 = it.y - 0.85 * it.h - (it.drift || 0)
    const y1 = it.y + it.h + (it.drift || 0)

    const dr = Math.hypot(it.x, it.z) - rad - V.radius
    const dy = Math.max(V.minY - y1, y0 - V.maxY, 0)
    // Clear horizontally AND vertically: the gap is the hypotenuse of the two.
    // Clear in only one: that one is the gap. Clear in neither: overlapping,
    // and the negative number is the depth of the overlap.
    const d = dr > 0 && dy > 0 ? Math.hypot(dr, dy) : Math.max(dr, dy)
    if (d < worst) worst = d
  }
  return worst
}

/**
 * Fail closed. A backdrop that a player can touch is not a backdrop, it is a
 * bug with a view — and it is the specific bug `Archipelago.verify()`'s
 * scenery check exists to catch on the other level.
 */
export function assertClear(items) {
  const c = clearanceOf(items)
  if (c < CLEARANCE) {
    throw new Error(`void backdrop: an instance is ${c.toFixed(1)} m from the play `
      + `volume (minimum ${CLEARANCE} m) — a player would reach it and fall through`)
  }
  return c
}

/**
 * Everything this layer will draw, as data, before any GPU object exists.
 * Exported so a tool (or `src/levels/void.js`, which owns the course and may
 * want to assert against it) can measure the layer without building it.
 */
export function voidBackdropSites() {
  const rand = rng(0xB4CD20)
  const bands = BANDS.map((b) => ({ band: b, items: bandInstances(b, rand) }))
  bands[0].items.push(...bandInstances({ ...FRAGMENTS, sides: BANDS[0].sides }, rand))
  return bands
}

export class VoidBackdrop {
  /**
   * @param {THREE.Scene} scene
   * @param {object} theme the theme descriptor from src/theme.js
   */
  constructor(scene, theme) {
    const bands = voidBackdropSites()
    this.clearance = assertClear(bands.flatMap((b) => b.items))

    const sky = theme.sky || {}
    const L = theme.light
    const rim = new THREE.Vector3(...theme.sunDir).normalize().negate()

    /**
     * ONE MATERIAL PER BAND, and that is the whole three-band mechanism.
     *
     * A single shared material can only express one extinction curve, and one
     * curve cannot put the near band below the dome and the far band above it
     * — it produces a monotone ramp in one direction, which is a fog bank.
     * Three materials cost nothing extra (they are the same program with
     * different uniform values, and each band is its own draw call regardless)
     * and they let the ladder in `BANDS` be authored as three explicit rungs
     * instead of hoped for.
     */
    const makeMaterial = (haze) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uTime: { value: 0 },
          // Declared by the shared sky include. Set for correctness even
          // though this shader calls scVoidGradient directly: a future edit
          // that goes through scSkyGradient must not silently get the skyline
          // branch.
          scSkyVoid: { value: 1 },
          uZenith: { value: new THREE.Color(sky.zenith != null ? sky.zenith : 0x000000) },
          uHaze: { value: new THREE.Color(sky.horizon != null ? sky.horizon : 0x000000) },
          uSkyTint: { value: new THREE.Color(L.hemiSky) },
          uGroundTint: { value: new THREE.Color(L.hemiGround) },
          uRimTint: { value: new THREE.Color(L.fillColor) },
          uRimDir: { value: rim },
          // [extinction per metre, transmittance floor, inscatter gain, body
          // brightness]. See the per-band notes in `BANDS` — those comments
          // carry the reasoning and the measured ratios.
          uHazeParams: { value: new THREE.Vector4(...haze) },
        },
        // Opaque. Additive backdrop geometry would let the bands sum through
        // each other, and the whole point of three bands is that the near one
        // OCCLUDES the far one.
        transparent: false,
        depthWrite: true,
        depthTest: true,
        side: THREE.FrontSide,
        fog: false,
      })
      // The aerial-perspective patcher only takes lit materials, but say so
      // anyway: this shader already contains its own haze and being patched
      // would apply it twice.
      m.userData.scNoPatch = true
      return m
    }
    this.materials = []

    this.meshes = []
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()

    for (const { band, items } of bands) {
      const geo = ruinGeometry(band.sides, band.seed, band.apex)
      const material = makeMaterial(band.haze)
      this.materials.push(material)
      const mesh = new THREE.InstancedMesh(geo, material, items.length)
      const seeds = new Float32Array(items.length)
      const drifts = new Float32Array(items.length)

      items.forEach((it, i) => {
        e.set(it.tilt, it.yaw, it.tilt * 0.6)
        q.setFromEuler(e)
        // The prism is authored with its BASE at y = 0, so an instance's y is
        // the underside of its body and its broken point hangs below that.
        p.set(it.x, it.y, it.z)
        s.set(it.w, it.h, it.d)
        m.compose(p, q, s)
        mesh.setMatrixAt(i, m)
        seeds[i] = it.seed
        drifts[i] = it.drift
      })
      mesh.instanceMatrix.needsUpdate = true
      geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1))
      geo.setAttribute('aDrift', new THREE.InstancedBufferAttribute(drifts, 1))

      // The instances span a kilometre; the base geometry's bound describes a
      // 1 m prism at the origin. InstancedMesh computes its own bounds from
      // the matrices, but only on demand — do it once, up front, so the culler
      // has the truth from the first frame instead of throwing the band away.
      mesh.computeBoundingSphere()
      // Like the sky sphere: this must read as infinitely far. A contact-shadow
      // ray that hit a backdrop mass would shadow a third of the frame.
      mesh.userData.scNoPrepass = true
      mesh.castShadow = false
      mesh.receiveShadow = false
      // AFTER the sky dome (renderOrder 0, and it writes no depth), so the
      // far band is not clipped by the dome's own 900 m radius — the outer
      // ring sits past it on purpose. Before the additive layers, which are 3.
      mesh.renderOrder = 1
      mesh.name = `void-backdrop-${band.name}`
      scene.add(mesh)
      this.meshes.push(mesh)
    }

    this.instances = bands.reduce((n, b) => n + b.items.length, 0)
    this.triangles = bands.reduce(
      (n, b) => n + b.items.length * b.band.sides * 4, 0)
  }

  update(time) {
    for (const m of this.materials) m.uniforms.uTime.value = time
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.parent?.remove(mesh)
      mesh.geometry.dispose()
      mesh.dispose()
    }
    for (const m of this.materials) m.dispose()
    this.materials.length = 0
    this.meshes.length = 0
  }
}
