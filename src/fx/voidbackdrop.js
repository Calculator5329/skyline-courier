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
 *    backdrop (470-600 m) still resolves a silhouette with facets in it; mid
 *    (690-850 m) reads as shape without value; far (780-1010 m) is washed
 *    almost to the fog. The first two are real geometry and are authored in
 *    `BANDS`; the third is BAKED and is authored in `IMPOSTORS` — see the long
 *    note there for why, and for what a single baked view does and does not
 *    get wrong. The three brightness rungs are the whole mechanism; see the
 *    note on `makeMaterial`.
 *    The extinction that separates them runs in this file's own shader — see
 *    the note on `uHaze` for why the scene's height-integrated aerial
 *    perspective is the wrong model at this range — but the colour it fades
 *    INTO is `scVoidGradient` from `render/skygrad.js`, the same single
 *    evaluation the dome and the aerial perspective use. A backdrop that faded
 *    to its own private violet would be the "distant geometry terminates
 *    against a colour the sky never reaches" bug that file was written to kill.
 *
 * 3. IT IS BACKDROP, SO IT COSTS BACKDROP MONEY. Three draw calls — two
 *    InstancedMeshes of prisms and one instanced quad — and under 24k
 *    triangles for the whole layer, of which the far band's ~8 400 apparent
 *    ruins are 1 976. LOD is by band and is decided at BUILD time rather than
 *    per frame: a thing that can never be approached can never need a closer
 *    mesh, so the far band is not merely cheap geometry, it is a picture of
 *    geometry. No runtime switch, no popping, no per-frame traverse.
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
  // THE FAR BAND IS NO LONGER HERE. It is baked — see `IMPOSTORS` below.
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

/* ==========================================================================
 * THE FAR BAND, BAKED.
 * ==========================================================================
 *
 * WHAT THIS REPLACES, AND WHAT IT IS ACTUALLY WORTH.
 *
 * The far band used to be 306 extruded prisms — 7 344 triangles and one draw
 * call. Measured against a void frame that renders 2.94 M triangles (the
 * course is drawn three times a frame: shadow maps, depth/normal prepass,
 * beauty), that band was **0.25 % of the frame**. So converting it to cards
 * "to save triangles" would have been a rounding error, and it would be
 * dishonest to report it as a performance win on its own.
 *
 * The win is the exchange rate, not the saving. A card is 2 triangles and
 * carries a whole CLUSTER of ruins — 8 to 14 masses, spires and plateaus
 * overlapping each other in depth. At 4 triangles per apparent ruin the far
 * band bought 306 objects; at 2 triangles per fourteen it buys thousands. That
 * is what Ethan's "less depth and detail in the backdrop and less overall
 * objects" asks for, and geometry could not have paid for it: the same density
 * as prisms is measured below in `docs/changelog.md` and it costs real frames.
 *
 * FIVE THINGS THIS HAD TO GET RIGHT.
 *
 * 1. IT STILL PARALLAXES. Every card sits at its own real world position and
 *    is billboarded there. The player climbs 508 m through a 142 m radius, so
 *    a card at 950 m sweeps up to 8.5 degrees of azimuth and 45 of elevation
 *    across a run — roughly 100 px and half a screen. All of that is real,
 *    because the card MOVES; only what is baked INTO the card is frozen. That
 *    is the difference between this and a painted wall, and it is why the
 *    cards are not one big sky sphere.
 *
 * 2. THE FROZEN PART IS BOUNDED, AND THE BOUND IS MEASURED, NOT HOPED FOR.
 *    What a single baked view gets wrong is INTRA-cluster parallax: the shift
 *    of a cluster's near piece against its far piece. For a baseline b, a
 *    cluster of depth t at distance d that is b*t/d^2 radians. The worst case
 *    here is the whole lateral extent of the course against the nearest card:
 *    b = 142 m, t = 150 m, d = 880 m gives 0.0275 rad — 1.6 degrees, about 18
 *    px at this fov and resolution, accumulated over the ENTIRE climb. Under a
 *    tenth of the parallax the card's own position provides. So azimuth gets
 *    ONE bake and that is a defensible trade.
 *
 *    ELEVATION is not, and this is where a naive impostor breaks. The player
 *    climbs 725 m; a card at y = -700 is seen from -38 degrees at the plaza
 *    and -52 at the spire, and one at y = +700 swings from +38 to +11. Tens of
 *    degrees, not one. So elevation is baked as FIVE SLICES across +/-50
 *    degrees and the card cross-fades between the two that bracket it — the
 *    residual is under 12.5 degrees of a shape that is 85 % haze, and it
 *    changes continuously, so there is no pop.
 *
 *    Re-baking on a threshold was the alternative and it was rejected: it puts
 *    an unbounded GPU spike on an arbitrary frame during play, to fix an error
 *    that a fifth of a megabyte of atlas fixes for free at boot.
 *
 * 3. THE FOG IS APPLIED EXACTLY ONCE, AT RUNTIME. Nothing about the theme is
 *    baked into the atlas. What the bake stores is the SHADING INPUTS, not the
 *    shaded pixel: R = the hemispheric up-factor, G = the rim term, B = the
 *    per-piece value wobble, A = coverage. The card's fragment shader then runs
 *    the SAME body-and-haze arithmetic `FRAG` runs, off the same uniforms, with
 *    the same `scVoidGradient` inscatter. So a card cannot arrive un-hazed and
 *    cannot double-haze, the palette stays live under a theme change, and an
 *    8-bit atlas is plenty because every channel it holds is a 0..1 factor
 *    rather than a colour that would band in the dark.
 *
 * 4. THE SORT IS NOT A SORT. Alpha-BLENDED cards would need back-to-front
 *    order against each other and against the two geometry bands, every frame,
 *    for ~1500 instances. Instead the cards are ALPHA-TESTED with depth write,
 *    which is order-independent by construction: they occlude each other and
 *    are occluded by the near and mid bands through the depth buffer, exactly
 *    as the prisms they replace were. The usual cost of alpha test — a hard,
 *    aliased silhouette — is paid off by `alphaToCoverage` against the
 *    pipeline's existing 4x MSAA scene target (src/render/index.js), which
 *    resolves the cut edge at sample resolution and stays order-independent.
 *
 * 5. NOTHING IS REACHABLE. The cards go through the same `assertClear()` the
 *    prisms do, as boxes of their full world size.
 */
const IMPOSTORS = {
  /** Distinct baked clusters. Doubled to 32 apparent shapes by mirroring. */
  archetypes: 16,
  /** Elevation slices, evenly spaced across +/- `elMax`. */
  slices: 5,
  /** Half the baked elevation range, radians. */
  elMax: 50 * Math.PI / 180,
  /**
   * Tile edge in atlas pixels, and the atlas grid.
   *
   * 16 x 5 = 80 tiles in a 9 x 9 grid at 224 px is a 2016 px atlas — under the
   * 2048 px WebGL2 guarantees, deliberately, so this cannot be the thing that
   * fails on a weaker GPU than the one it was authored on. A card is about 136
   * px tall on a 900 px frame at 950 m (a 200 m cluster, 76 deg fov), so 224 px
   * of tile is a real oversample rather than a stretch.
   */
  tile: 224,
  cols: 9,
  rows: 9,
  /** Fraction of the tile the cluster is normalised into; the rest is margin
   *  so mip generation cannot bleed one tile into its neighbour. */
  fit: 0.92,
  /** Pieces per baked cluster. This is the DETAIL dial; card count is the
   *  density dial, and conflating them is what made the first build gravel. */
  pieces: [6, 11],
  seed: 0x51d7b3,

  /**
   * WHERE THE CARDS GO.
   *
   * The ring is the old far band's, because that geometry is set by the CAMERA
   * FAR PLANE (1200 m, src/main.js) and not by taste. A card is perpendicular
   * to the view ray, so its corners are only ~8 m further from the camera than
   * its centre — unlike a prism, whose 180 m of width put its far corner 90 m
   * out. That is why the ring can stay this far out at this size at all.
   *
   * The vertical extent is another matter, and it is the one place the far
   * plane genuinely bites: a card at y = +900 seen from the plaza is 1345 m
   * away and would be CLIPPED, which the old far band was — the hard edge at
   * the top of `summit`. `VERT_CARD` squashes anything past the far plane into
   * the last half-percent of the depth range, monotonically, so the outermost
   * cards fade into fog rather than being cut off. They are 90 %+ inscatter by
   * then; what is lost is depth precision between two things that are the same
   * colour.
   */
  // The inner edge deliberately OVERLAPS the mid band (690-850 m). Cards and
  // prisms depth-test against each other, so an impostor at 790 m can stand
  // behind a mid-band mass and in front of another card — which is the only
  // way a far layer reads as several distances rather than as one shell. A
  // wide radial spread is also the cheapest richness there is: a card further
  // away is smaller on screen, so depth costs less fill than density does.
  radius: [780, 1010], y: [-980, 980],
  clusters: 56, per: [12, 24],
  spreadAng: 0.34, spreadRad: 90, spreadY: 360,
  /**
   * Card edge in metres = the cluster's baked world span x this.
   *
   * THE NUMBER THAT DECIDES WHETHER THIS IS A BACKDROP OR A WALL. Screen
   * coverage goes as the square of it. The shell is a cylinder ~935 m in radius
   * and 2000 m tall — 11.5 Mm2 of surface — and ~720 cards averaging 250 m at
   * about 42 % alpha coverage puts ~1.35 layers of card over it. Enough to
   * overlap and read as depth; not enough to close §5's gaps, which are the
   * thing that reads as depth in the first place. Above ~2 it is opaque and the
   * overdraw shows up in ms/f before it shows up in the frame.
   */
  scale: [0.38, 0.94],
  aspect: [0.88, 1.12],
  /**
   * THE FAINT RUNG, inherited verbatim from the band this replaces. §5's
   * "washed almost to the fog colour" — the fog is near-black now, so the far
   * layer is a suggestion of structure at the edge of visibility rather than a
   * lit backdrop. [extinction/m, transmittance floor, inscatter gain, body
   * brightness].
   */
  haze: [0.0016, 0.04, 1.00, 0.16],
}

/**
 * ONE CLUSTER, as a list of placed prisms in local metres.
 *
 * This is the whole reason a card is worth more than a prism: the thing baked
 * into a tile is not a rock, it is a DISTRICT — plateaus with spires standing
 * off them, a taller mass behind, rubble in front, all overlapping in depth so
 * the silhouette has notches and gaps in it. §5 asks for "layer on layer of
 * ruins" and this is the only affordable place to put the layers, because
 * every one of them is free once it is a texel.
 *
 * The pieces are spread in Z as much as in X. A cluster flat against the card
 * plane would bake as a row of shapes; one with depth bakes as an overlap, and
 * the overlap is what reads as a place rather than a pattern.
 */
function clusterPieces(rand) {
  const n = IMPOSTORS.pieces[0]
    + Math.floor(rand() * (IMPOSTORS.pieces[1] - IMPOSTORS.pieces[0] + 1))
  const out = []
  // A dominant mass so the cluster has a subject, then satellites around it.
  //
  // THE PIECES ARE BIG ON PURPOSE, and this is the thing the first build got
  // wrong. Twelve small stones per tile baked down to a spray of two-texel
  // chips, and 1500 of those cards is not a ruined city, it is gravel — the
  // reference has large distinct masses with gaps between them, not noise. So
  // the lead mass owns a third of the tile, there are FEWER pieces, and the
  // rubble class is rare. Density now comes from the number of cards, and
  // detail from the number of pieces, and those are two different dials.
  for (let i = 0; i < n; i++) {
    const lead = i === 0
    const r = rand()
    // §4.2's floating ruin platforms: wide, thin slabs. They are the element
    // that most says "built" at this range, because nothing natural is flat.
    const slab = !lead && r < 0.26
    const spire = !lead && r >= 0.26 && r < 0.56
    const rubble = !lead && r >= 0.88
    const w = lead ? 62 + rand() * 52
      : slab ? 34 + rand() * 54
        : spire ? 11 + rand() * 13
          : rubble ? 7 + rand() * 12
            : 24 + rand() * 40
    const h = spire ? w * (2.6 + rand() * 3.2)
      : slab ? w * (0.14 + rand() * 0.20)
        : lead ? w * (0.45 + rand() * 0.75)
          : w * (0.34 + rand() * 0.90)
    out.push({
      x: lead ? 0 : (rand() - 0.5) * 200,
      y: lead ? 0 : (rand() - 0.5) * 176,
      z: lead ? 0 : (rand() - 0.5) * 180,
      w,
      d: w * (0.55 + rand() * 0.9),
      h,
      yaw: rand() * Math.PI * 2,
      tilt: (rand() - 0.5) * (spire ? 0.06 : 0.16),
      seed: rand(),
      sides: spire ? 5 : 7,
      apex: slab ? 0.55 + rand() * 0.5 : 0.30 + rand() * 0.25,
    })
  }
  return out
}

/**
 * Where the cards sit, as plain data — same shape `bandInstances()` returns so
 * `clearanceOf()` can measure both without knowing which is which.
 */
export function voidImpostorSites(sizes = null) {
  const rand = rng(0x33F1A7)
  const B = IMPOSTORS
  const out = []
  // A card's world size is the baked tile's span x its own scale. Without the
  // bake (a tool measuring clearance headlessly) fall back to a span larger
  // than any cluster produces, because the only direction a clearance input may
  // be wrong in is "too big".
  const spanOf = (a) => (sizes ? sizes[a] : 420)
  for (let c = 0; c < B.clusters; c++) {
    const cAng = (c / B.clusters + rand() * 0.5 / B.clusters) * Math.PI * 2
    const cRad = B.radius[0] + rand() * (B.radius[1] - B.radius[0])
    const cY = B.y[0] + rand() * (B.y[1] - B.y[0])
    const n = B.per[0] + Math.floor(rand() * (B.per[1] - B.per[0] + 1))
    for (let i = 0; i < n; i++) {
      const a = cAng + (rand() - 0.5) * B.spreadAng
      const r = cRad + (rand() - 0.5) * B.spreadRad
      const y = cY + (rand() - 0.5) * B.spreadY
      const arch = Math.floor(rand() * B.archetypes)
      const scale = B.scale[0] + rand() * (B.scale[1] - B.scale[0])
      const aspect = B.aspect[0] + rand() * (B.aspect[1] - B.aspect[0])
      const size = spanOf(arch) * scale
      out.push({
        x: Math.cos(a) * r,
        y,
        z: Math.sin(a) * r,
        archetype: arch,
        size,
        aspect,
        flip: rand() < 0.5 ? 1 : 0,
        seed: rand(),
        // The card as a box, for `clearanceOf()`. A billboard has no thickness,
        // but it sweeps its own width as the camera moves around it, so the
        // honest occupied volume is a box of its full extent in every axis.
        w: size, d: size, h: size * aspect,
      })
    }
  }
  return out
}

/**
 * What the bake writes. NOT a picture — see note 3 on `IMPOSTORS`.
 *
 * `aNormalW` is carried as its own attribute rather than read from `normal`
 * because the bake rotates the cluster to fake the camera's elevation, and a
 * rotated normal would bake the wrong hemisphere lighting into the tile. The
 * positions turn; the shading frame does not.
 */
const VERT_BAKE = /* glsl */`
  attribute vec3 aNormalW;
  attribute float aSeed;
  varying vec3 vNW;
  varying float vSeed;
  void main() {
    vNW = aNormalW;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG_BAKE = /* glsl */`
  uniform vec3 uRimDir;
  varying vec3 vNW;
  varying float vSeed;
  void main() {
    vec3 N = normalize(vNW);
    gl_FragColor = vec4(
      N.y * 0.5 + 0.5,                                   // hemispheric factor
      pow(max(dot(N, normalize(uRimDir)), 0.0), 5.0),    // rim term
      fract(vSeed * 71.317),                             // per-piece wobble
      1.0                                                // coverage
    );
  }
`

const VERT_CARD = /* glsl */`
  ${SKY_GRADIENT_GLSL}

  attribute vec3 aPos;
  attribute float aTile;
  attribute float aSize;
  attribute float aAspect;
  attribute float aFlip;
  attribute float aSeed;

  uniform float uCols, uRows, uSlices, uElMax;
  uniform vec3 uZenith;
  uniform vec3 uHaze;
  uniform vec4 uHazeParams;

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying float vBlend;
  varying float vT;
  varying vec3 vFog;
  varying float vSeed;

  vec2 tileUv(float t, vec2 q) {
    float col = mod(t, uCols);
    float row = floor(t / uCols);
    return (vec2(col, row) + q) / vec2(uCols, uRows);
  }

  void main() {
    vec3 c = aPos;
    vec3 toCam = cameraPosition - c;
    float d = max(length(toCam), 1e-4);
    vec3 N = toCam / d;

    // The billboard keeps WORLD UP up. A fully spherical billboard would roll
    // the ruins with the camera, and a ruin that rolls is a sprite; a cylinder
    // billboard (up locked to world up) would slant the card away from the
    // camera at high elevation and squash the tile. This is the third option
    // and the one the elevation slices are baked to match: face the camera,
    // and take up from world up projected into the card plane.
    vec3 wUp = vec3(0.0, 1.0, 0.0);
    vec3 U = wUp - N * dot(wUp, N);
    float ul = length(U);
    U = ul > 1e-3 ? U / ul : vec3(0.0, 0.0, 1.0);
    vec3 R = normalize(cross(U, N));

    vec3 world = c + R * (position.x * aSize) + U * (position.y * aSize * aAspect);

    // Which two elevation slices bracket the camera, and how far between.
    float el = asin(clamp(dot(N, wUp), -1.0, 1.0));
    float sf = clamp(el / uElMax * 0.5 + 0.5, 0.0, 1.0) * (uSlices - 1.0);
    float s0 = floor(sf);
    float s1 = min(s0 + 1.0, uSlices - 1.0);
    vBlend = sf - s0;

    vec2 q = uv;
    q.x = mix(q.x, 1.0 - q.x, aFlip);
    vUv0 = tileUv(aTile * uSlices + s0, q);
    vUv1 = tileUv(aTile * uSlices + s1, q);

    // THE HAZE IS SOLVED HERE, NOT PER FRAGMENT, and that is a measured
    // decision rather than a stylistic one. These cards cover the shell about
    // 1.4 times over and the quads that carry them cover it far more, so this
    // shader's output is rasterised roughly twenty times per screen pixel.
    // scVoidGradient at that rate cost 4-5 ms/frame. It is a smooth function of
    // view direction over a shape that is at most a few hundred pixels, so
    // evaluating it at four corners and interpolating is visually identical and
    // an order of magnitude cheaper. The geometry bands, which cover a few
    // percent of the frame, keep theirs per fragment.
    vec3 toCamV = cameraPosition - world;
    float dist = length(toCamV);
    vec3 dirW = -toCamV / max(dist, 1e-4);
    vT = max(exp(-dist * uHazeParams.x), uHazeParams.y);
    vFog = scVoidGradient(dirW, uZenith, uHaze) * uHazeParams.z * (1.0 - vT);
    vSeed = aSeed;

    vec4 clip = projectionMatrix * viewMatrix * vec4(world, 1.0);

    // PAST THE FAR PLANE, DON'T CLIP — SQUASH.
    //
    // The ring is 860-1010 m and the cards run +/-980 m vertically, so from the
    // plaza the highest of them are 1400 m out against a 1200 m far plane. The
    // old far band simply vanished there, which is a hard horizontal cut across
    // the top of the summit shot and the bottom of plunge — the exact opposite of
    // "the depth keeps going". This maps everything beyond 0.99 NDC into the
    // last 1 % of the range, MONOTONICALLY, so relative order survives (no ties,
    // no z-fight) and nothing is cut. It is the skybox trick with the ordering
    // kept.
    float ndc = clip.z / clip.w;
    if (ndc > 0.99) ndc = 0.99 + 0.00998 * (1.0 - 1.0 / (1.0 + (ndc - 0.99) * 60.0));
    clip.z = ndc * clip.w;
    gl_Position = clip;
  }
`

const FRAG_CARD = /* glsl */`
  uniform sampler2D uAtlas;
  uniform vec3 uSkyTint;
  uniform vec3 uGroundTint;
  uniform vec3 uRimTint;
  uniform vec4 uHazeParams;

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying float vBlend;
  varying float vT;
  varying vec3 vFog;
  varying float vSeed;

  void main() {
    vec4 t = mix(texture2D(uAtlas, vUv0), texture2D(uAtlas, vUv1), vBlend);

    // ORDER-INDEPENDENT, AND STILL ANTI-ALIASED.
    //
    // See note 4 on IMPOSTORS: this is a cut, not a blend, so nothing has to be
    // sorted. The usual price of a cut is a staircase, and the price is paid
    // off here by rescaling the coverage into ONE PIXEL either side of the 0.5
    // contour and handing that to alpha-to-coverage, which resolves it against
    // the 4x MSAA scene target (src/render/index.js) at sample resolution. The
    // output alpha is what alpha-to-coverage reads — writing 1.0 here and
    // relying on the texture's alpha would have silently produced hard edges.
    //
    // If MSAA is ever off, this degrades to a plain cut about half a pixel out
    // from where a 0.5 alphaTest would have put it, rather than to a field of
    // opaque squares — which is what a bare "output t.a" would degrade to.
    float cov = (t.a - 0.5) / max(fwidth(t.a), 1e-4) + 0.5;
    if (cov < 0.0) discard;

    // --- the mass, rebuilt from the baked factors --------------------------
    // Deliberately the same arithmetic as FRAG above, off the same uniforms.
    // If one of them changes the other has to, and they should be read as one.
    float up = t.r;
    vec3 body = mix(uGroundTint, uSkyTint, up * up) * uHazeParams.w;
    body += uRimTint * t.g * 0.015;
    body *= 0.72 + 0.56 * t.b;
    // A second wobble, per CARD rather than per piece: 16 archetypes across
    // hundreds of cards would otherwise read as sixteen repeats at one value.
    body *= 0.80 + 0.42 * fract(vSeed * 53.719);

    // --- the haze ----------------------------------------------------------
    // Applied ONCE, and nothing about the fog is in the atlas — but the
    // expensive half of it (the sky gradient) was solved per vertex. See the
    // note in VERT_CARD.
    gl_FragColor = vec4(body * vT + vFog, clamp(cov, 0.0, 1.0));
  }
`

/**
 * Bake every archetype x elevation slice into one atlas, in ONE draw call.
 *
 * The layout trick is worth stating because it is what keeps the bake off the
 * first frame's budget: instead of 80 render-target passes with a camera moved
 * between them, every tile is baked as its own geometry, pre-rotated by its
 * slice's elevation and pre-translated to its cell of the atlas, all merged
 * into a single buffer under one orthographic camera. Rotating the CLUSTER by
 * `el` and viewing it head-on is the same picture as viewing the cluster from
 * elevation `el`, so the camera never has to move — which is what makes the
 * whole atlas one draw.
 *
 * @returns {{texture: THREE.Texture, target: THREE.WebGLRenderTarget,
 *            sizes: Float32Array, ms: number, triangles: number}}
 */
function bakeImpostorAtlas(renderer, theme) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now()
  const B = IMPOSTORS
  const rand = rng(B.seed)

  const clusters = []
  const sizes = new Float32Array(B.archetypes)

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const v = new THREE.Vector3()
  const sc = new THREE.Vector3()
  const nmat = new THREE.Matrix3()

  for (let a = 0; a < B.archetypes; a++) {
    // --- the cluster, once, in metres -------------------------------------
    //
    // Deliberately flat arithmetic on flat arrays. The first version did this
    // with a Vector3 per vertex and `applyMatrix4`, which is idiomatic three
    // and cost 42 ms of the boot — for 54 000 vertices that is all allocation
    // and method dispatch, and it is the only part of this file that runs
    // while the player is looking at a loading screen.
    const pieces = clusterPieces(rand)
    const geos = pieces.map((p) =>
      ruinGeometry(p.sides, Math.floor(p.seed * 0xffffff) + 1, p.apex))
    let nv = 0
    for (const g of geos) nv += g.getAttribute('position').count
    const cp = new Float32Array(nv * 3)
    const cn = new Float32Array(nv * 3)
    const cs = new Float32Array(nv)

    let w = 0
    for (let pi = 0; pi < pieces.length; pi++) {
      const p = pieces[pi]
      const geo = geos[pi]
      const P = geo.getAttribute('position').array
      const N = geo.getAttribute('normal').array
      const count = geo.getAttribute('position').count
      e.set(p.tilt, p.yaw, p.tilt * 0.6)
      q.setFromEuler(e)
      m.compose(v.set(p.x, p.y, p.z), q, sc.set(p.w, p.h, p.d))
      nmat.getNormalMatrix(m)
      const E = m.elements
      const F = nmat.elements
      for (let i = 0; i < count; i++) {
        const j = i * 3
        const x = P[j], y = P[j + 1], z = P[j + 2]
        cp[w * 3] = E[0] * x + E[4] * y + E[8] * z + E[12]
        cp[w * 3 + 1] = E[1] * x + E[5] * y + E[9] * z + E[13]
        cp[w * 3 + 2] = E[2] * x + E[6] * y + E[10] * z + E[14]
        const nx = N[j], ny = N[j + 1], nz = N[j + 2]
        let ax = F[0] * nx + F[3] * ny + F[6] * nz
        let ay = F[1] * nx + F[4] * ny + F[7] * nz
        let az = F[2] * nx + F[5] * ny + F[8] * nz
        const len = Math.hypot(ax, ay, az) || 1
        cn[w * 3] = ax / len
        cn[w * 3 + 1] = ay / len
        cn[w * 3 + 2] = az / len
        cs[w] = p.seed
        w++
      }
      geo.dispose()
    }

    // --- one normalisation for ALL slices ---------------------------------
    // The union of every slice's projected bounds, not each slice's own. Two
    // slices normalised separately would sit at different scales and offsets in
    // their tiles, and the cross-fade between them would be a zoom.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (let s = 0; s < B.slices; s++) {
      const el = (s / (B.slices - 1) * 2 - 1) * B.elMax
      const c = Math.cos(el), sn = Math.sin(el)
      for (let i = 0; i < cp.length; i += 3) {
        const py = cp[i + 1] * c - cp[i + 2] * sn
        if (cp[i] < x0) x0 = cp[i]
        if (cp[i] > x1) x1 = cp[i]
        if (py < y0) y0 = py
        if (py > y1) y1 = py
      }
    }
    const cx = (x0 + x1) * 0.5
    const cy = (y0 + y1) * 0.5
    const half = Math.max(x1 - x0, y1 - y0) * 0.5
    // The tile spans this many metres edge to edge, margin included. This is
    // the number a card is scaled by, so a card's metres and the atlas agree.
    const span = (half * 2) / B.fit
    sizes[a] = span
    clusters.push({ cp, cn, cs, cx, cy, k: 1 / span, nv })
  }

  // --- lay every cluster into its tiles, one buffer, one draw ---------------
  let total = 0
  for (const c of clusters) total += c.nv * B.slices
  const pos = new Float32Array(total * 3)
  const nrm = new Float32Array(total * 3)
  const sds = new Float32Array(total)
  let w2 = 0
  for (let a = 0; a < clusters.length; a++) {
    const { cp, cn, cs, cx, cy, k, nv } = clusters[a]
    for (let s = 0; s < B.slices; s++) {
      const el = (s / (B.slices - 1) * 2 - 1) * B.elMax
      const c = Math.cos(el), sn = Math.sin(el)
      const t = a * B.slices + s
      const ox = (t % B.cols) + 0.5
      const oy = Math.floor(t / B.cols) + 0.5
      for (let i = 0; i < nv; i++) {
        const j = i * 3
        const px = cp[j], py = cp[j + 1], pz = cp[j + 2]
        pos[w2 * 3] = (px - cx) * k + ox
        pos[w2 * 3 + 1] = (py * c - pz * sn - cy) * k + oy
        pos[w2 * 3 + 2] = (py * sn + pz * c) * k
        nrm[w2 * 3] = cn[j]
        nrm[w2 * 3 + 1] = cn[j + 1]
        nrm[w2 * 3 + 2] = cn[j + 2]
        sds[w2] = cs[i]
        w2++
      }
    }
  }

  // Split, because the two halves of this cost have different fixes: geometry
  // is CPU and is the part that grows with `archetypes` x `slices` x `pieces`,
  // the rest is one upload and one draw.
  const cpuMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aNormalW', new THREE.BufferAttribute(nrm, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(sds, 1))

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT_BAKE,
    fragmentShader: FRAG_BAKE,
    uniforms: {
      uRimDir: { value: new THREE.Vector3(...theme.sunDir).normalize().negate() },
    },
    side: THREE.FrontSide,
    depthTest: true,
    depthWrite: true,
    fog: false,
  })
  mat.userData.scNoPatch = true

  const mesh = new THREE.Mesh(geo, mat)
  const bakeScene = new THREE.Scene()
  bakeScene.add(mesh)
  // Tile units, so the camera is the grid.
  const cam = new THREE.OrthographicCamera(0, B.cols, B.rows, 0, -8, 8)
  cam.position.set(0, 0, 4)

  const target = new THREE.WebGLRenderTarget(B.cols * B.tile, B.rows * B.tile, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    generateMipmaps: true,
    // Resolved 4x MSAA, so the coverage channel arrives with real intermediate
    // values for `alphaToCoverage` to work with instead of a binary mask.
    samples: 4,
  })
  target.texture.name = 'void-impostor-atlas'
  // The atlas holds FACTORS, not colours — no sRGB decode may be applied to it.
  target.texture.colorSpace = THREE.NoColorSpace

  const prevTarget = renderer.getRenderTarget()
  const prevClear = new THREE.Color()
  renderer.getClearColor(prevClear)
  const prevAlpha = renderer.getClearAlpha()
  const prevAutoClear = renderer.autoClear

  renderer.setRenderTarget(target)
  // Clear to a NEUTRAL factor set, not to black: mip generation averages across
  // the silhouette, and a black rgb outside the shape would drag a dark fringe
  // into every edge as the card minifies. Alpha 0 is what actually marks
  // "nothing here".
  renderer.setClearColor(new THREE.Color(0.5, 0.0, 0.5), 0)
  renderer.autoClear = true
  renderer.clear(true, true, false)
  renderer.render(bakeScene, cam)
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClear, prevAlpha)
  renderer.autoClear = prevAutoClear

  const triangles = pos.length / 9
  geo.dispose()
  mat.dispose()

  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0
  return { target, texture: target.texture, sizes, ms, cpuMs, triangles }
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
   * @param {THREE.WebGLRenderer} [renderer] required for the baked far band;
   *   without it the layer builds the two geometry bands and no cards, which
   *   is what a headless measurement wants.
   */
  constructor(scene, theme, renderer = null) {
    const bands = voidBackdropSites()

    // --- the baked far band -------------------------------------------------
    // Baked BEFORE the clearance assertion, because a card's world size is the
    // baked tile's span and the assertion has to measure the real number rather
    // than a guess. See `IMPOSTORS`.
    this.atlas = renderer ? bakeImpostorAtlas(renderer, theme) : null
    this.bakeMs = this.atlas ? this.atlas.ms : 0
    this.bakeCpuMs = this.atlas ? this.atlas.cpuMs : 0
    this.bakeTriangles = this.atlas ? this.atlas.triangles : 0
    const cards = this.atlas ? voidImpostorSites(this.atlas.sizes) : []

    this.clearance = assertClear([...bands.flatMap((b) => b.items), ...cards])

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

    // --- the cards ----------------------------------------------------------
    if (cards.length) {
      const B = IMPOSTORS
      // A quad, and nothing else. Two triangles carry a whole ruin district.
      const quad = new THREE.InstancedBufferGeometry()
      quad.setIndex([0, 1, 2, 0, 2, 3])
      quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
      ]), 3))
      quad.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
        0, 0, 1, 0, 1, 1, 0, 1,
      ]), 2))

      const aPos = new Float32Array(cards.length * 3)
      const aTile = new Float32Array(cards.length)
      const aSize = new Float32Array(cards.length)
      const aAspect = new Float32Array(cards.length)
      const aFlip = new Float32Array(cards.length)
      const aSeed = new Float32Array(cards.length)
      cards.forEach((c, i) => {
        aPos[i * 3] = c.x; aPos[i * 3 + 1] = c.y; aPos[i * 3 + 2] = c.z
        aTile[i] = c.archetype
        aSize[i] = c.size
        aAspect[i] = c.aspect
        aFlip[i] = c.flip
        aSeed[i] = c.seed
      })
      quad.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3))
      quad.setAttribute('aTile', new THREE.InstancedBufferAttribute(aTile, 1))
      quad.setAttribute('aSize', new THREE.InstancedBufferAttribute(aSize, 1))
      quad.setAttribute('aAspect', new THREE.InstancedBufferAttribute(aAspect, 1))
      quad.setAttribute('aFlip', new THREE.InstancedBufferAttribute(aFlip, 1))
      quad.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1))
      quad.instanceCount = cards.length

      const cardMat = new THREE.ShaderMaterial({
        vertexShader: VERT_CARD,
        fragmentShader: FRAG_CARD,
        uniforms: {
          scSkyVoid: { value: 1 },
          uAtlas: { value: this.atlas.texture },
          uCols: { value: B.cols },
          uRows: { value: B.rows },
          uSlices: { value: B.slices },
          uElMax: { value: B.elMax },
          uZenith: { value: new THREE.Color(sky.zenith != null ? sky.zenith : 0x000000) },
          uHaze: { value: new THREE.Color(sky.horizon != null ? sky.horizon : 0x000000) },
          uSkyTint: { value: new THREE.Color(L.hemiSky) },
          uGroundTint: { value: new THREE.Color(L.hemiGround) },
          uRimTint: { value: new THREE.Color(L.fillColor) },
          uHazeParams: { value: new THREE.Vector4(...B.haze) },
        },
        // NOT `transparent`. See note 4 on IMPOSTORS: a cut plus depth write is
        // order-independent, and `alphaToCoverage` against the pipeline's 4x
        // MSAA scene target is what buys back the edge quality that an
        // alpha-tested silhouette normally costs. Marking it transparent would
        // also push it into the transparent queue behind the beams and put it
        // on the prepass exclusion list for the wrong reason.
        // No `alphaTest`: three's alpha-test chunk is not in this shader and
        // the cut is done by hand in FRAG_CARD, one pixel wide, so that
        // alpha-to-coverage has a gradient to resolve instead of a step.
        transparent: false,
        alphaToCoverage: true,
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
      })
      cardMat.userData.scNoPatch = true
      this.materials.push(cardMat)

      const cardMesh = new THREE.Mesh(quad, cardMat)
      // The quad is a unit square at the origin until the vertex shader places
      // it, so no bounding volume computed from the buffers can be right, and
      // a wrong one culls the entire far band. The layer is a shell around the
      // player and some of it is on screen in every frame anyway.
      cardMesh.frustumCulled = false
      cardMesh.userData.scNoPrepass = true
      cardMesh.castShadow = false
      cardMesh.receiveShadow = false
      cardMesh.renderOrder = 1
      cardMesh.name = 'void-backdrop-far-impostors'
      scene.add(cardMesh)
      this.meshes.push(cardMesh)
    }

    this.cards = cards.length
    /** Apparent ruins the cards carry, for the record: each is a whole cluster. */
    this.cardPieces = cards.length * (IMPOSTORS.pieces[0] + IMPOSTORS.pieces[1]) / 2
    this.instances = bands.reduce((n, b) => n + b.items.length, 0) + cards.length
    this.triangles = bands.reduce(
      (n, b) => n + b.items.length * b.band.sides * 4, 0) + cards.length * 2
  }

  update(time) {
    for (const m of this.materials) {
      if (m.uniforms.uTime) m.uniforms.uTime.value = time
    }
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.parent?.remove(mesh)
      mesh.geometry.dispose()
      if (mesh.isInstancedMesh) mesh.dispose()
    }
    for (const m of this.materials) m.dispose()
    if (this.atlas) this.atlas.target.dispose()
    this.atlas = null
    this.materials.length = 0
    this.meshes.length = 0
  }
}
