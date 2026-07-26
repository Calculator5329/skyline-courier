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
 * 2. THE BANDS ARE THREE, THEY ARE DISTANCES, AND EVERY ONE OF THEM IS DARKER
 *    THAN THE DOME. Near (470-600 m) is a hard silhouette at about 0.55 of the
 *    dome's value; mid (690-850 m) sits at 0.66; far (880-1000 m) is washed
 *    almost to the fog at 0.78 — almost, and from the DARK side.
 *
 *    CORRECTED 2026-07-26. Those ratios used to be 0.95 / 1.50 / 1.85, with
 *    the far band deliberately lighter than the sky on the reasoning that a
 *    distant mass is mostly the lit haze in front of it. That is true of a
 *    daylit valley and false here: the void's haze is lit from below and
 *    behind, so the reference shows dark spires standing IN FRONT OF a glowing
 *    violet volume. A layer authored lighter than its background is a fog bank
 *    with lumps in it — §8.3's "fog thick enough to hide the fact that nothing
 *    was built behind it" — and the review said so in those words: "pale flat
 *    origami". Contrast still falls with distance, which is what aerial
 *    perspective does; it just never crosses over.
 *
 *    The extinction that separates them runs in this file's own shader — see
 *    the note on `uHaze` for why the scene's height-integrated aerial
 *    perspective is the wrong model at this range — but the colour it fades
 *    INTO is `scVoidGradient` from `render/skygrad.js`, the same single
 *    evaluation the dome and the aerial perspective use. A backdrop that faded
 *    to its own private violet would be the "distant geometry terminates
 *    against a colour the sky never reaches" bug that file was written to kill.
 *
 * 3. IT IS BACKDROP, SO IT COSTS BACKDROP MONEY — but the old budget was a
 *    false economy. Ten InstancedMeshes (four silhouette archetypes across
 *    three bands), ten draw calls and about 176k triangles, against a course
 *    that is already 2.9 MILLION. The layer that came before this was 29k
 *    triangles — one percent of the frame for the half of the frame the
 *    backdrop occupies — and it spent that budget on one cone repeated a
 *    thousand times. LOD is by band and is decided at build time rather than
 *    per frame: a thing that can never be approached can never need a closer
 *    mesh, so the far band is simply authored with fewer sides. No runtime
 *    switch, no popping, no per-frame traverse.
 *
 *    Surface detail is a shader, not a texture: storey grooves, panel breaks,
 *    a per-face value break, an edge glow and a sparse emissive glint grid,
 *    all sized in METRES and all sized above the pixel they land on. See the
 *    "internal structure" block in `FRAG`.
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
 * THE UNIT CELL every archetype is authored into.
 *
 * x and z run -0.5..0.5 and y runs GEO_MIN_Y..GEO_MAX_Y, so an instance's
 * scale IS its size in metres and `clearanceOf()` can bound any instance
 * without knowing which archetype it drew. Every builder below is responsible
 * for staying inside it; `assertBounds()` proves it at build time rather than
 * trusting the comment, because the clearance check is downstream of it.
 */
const GEO_MIN_Y = -0.92
const GEO_MAX_Y = 1.18

/**
 * A tapered n-gon prism — the one primitive every archetype is built from.
 * Appends flat-shaded triangles to `pos` in place.
 *
 * Non-indexed and duplicated per face on purpose: `computeVertexNormals()`
 * then produces one normal per FACE, and hard normal breaks are the whole
 * reason these read as carved rather than as smooth blobs.
 *
 * @param {number[]} pos       triangle soup, appended to
 * @param {() => number} rand
 * @param {object} o
 */
function prism(pos, rand, o) {
  const {
    cx = 0, cz = 0, r = 0.5, y0 = 0, y1 = 1, sides = 6,
    top = 0.72, jitter = 0.3, yaw = 0,
    // How far below y0 the broken underside hangs. 0 = flat-bottomed.
    apex = 0,
    // How far above the top ring the point rises. 0 = broken flat top.
    tip = 0,
    // Vertical wobble on the top ring: broken masonry, not a milled edge.
    wobble = 0.1,
  } = o
  const ang = [], rb = [], rt = [], ty = []
  for (let i = 0; i < sides; i++) {
    ang.push(yaw + (i / sides) * Math.PI * 2)
    rb.push(r * (1 - jitter * 0.5 + rand() * jitter))
    rt.push(r * top * (1 - jitter * 0.5 + rand() * jitter))
    ty.push(y1 - (y1 - y0) * rand() * wobble)
  }
  // The cap centre sits at the MEAN of the ring unless a tip is asked for.
  // Pinning it to the maximum builds a little peak over every mass and turns
  // a ruin field into a crystal field — §4.3's crystals are a different
  // element owned by a different lane.
  const capY = tip > 0 ? y1 + tip : ty.reduce((a, b) => a + b, 0) / sides

  const P = (i, ring) => {
    if (ring === 'apex') return [cx, y0 - apex, cz]
    if (ring === 'centre') return [cx, capY, cz]
    const a = ang[i % sides]
    const rr = ring === 'base' ? rb[i % sides] : rt[i % sides]
    const y = ring === 'base' ? y0 : ty[i % sides]
    return [cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr]
  }
  const tri = (a, b, c) => { pos.push(...a, ...b, ...c) }

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    const b0 = P(i, 'base'), b1 = P(j, 'base')
    const t0 = P(i, 'top'), t1 = P(j, 'top')
    tri(b0, b1, t1)
    tri(b0, t1, t0)
    tri(t0, t1, P(0, 'centre'))
    if (apex > 0) tri(b1, b0, P(0, 'apex'))
  }
}

/**
 * THE SILHOUETTE VOCABULARY — four archetypes, not one cone.
 *
 * REWRITTEN 2026-07-26, and this is the second time the same complaint has
 * been made. Ethan: "less depth and detail in the backdrop". The review that
 * forced this one was blunter: the band above the deck was "a collection of
 * large pale-lavender flat-shaded polygons with no internal structure, no
 * windows, no fracture, no edge glow — literally paper triangles", and the
 * cause was structural rather than a tuning miss. There was ONE archetype (a
 * tapered prism with a point under it), it was drawn at three levels of detail
 * whose lowest was a 6-gon, and the far band's haze ratio was 1.26 — LIGHTER
 * than the dome. A single silhouette repeated a thousand times, lighter than
 * its background, is a fog bank with lumps in it, which is failure mode §8.3
 * verbatim: "fog thick enough to hide the fact that nothing was built behind
 * it".
 *
 * The reference is the opposite on both counts, and both are fixed here:
 * distant forms are DARKER than the haze around them (see `BANDS`), and they
 * are dozens of distinct silhouettes — gothic tower clusters, hanging ruin
 * chunks with dripping undersides, stepped ziggurats with needles on top,
 * crystal glints.
 *
 * WHY THIS IS AFFORDABLE. The old layer was ~29k triangles against a course of
 * 2.94 MILLION — it was one percent of the scene and it was spending that
 * budget on nothing. Each archetype below is a CLUSTER of six to fourteen
 * prisms, so a single instance reads as a district rather than as a rock, and
 * the whole layer still lands near 150k triangles: five percent of the frame,
 * for the half of the frame the backdrop actually occupies. The cost is draw
 * calls, and they go from 3 to 10 (an InstancedMesh is one geometry, so an
 * archetype per band is a call per band per archetype). Ten calls out of
 * 85-119 is the right trade for the thing the reviewer says is missing.
 *
 * `sides` remains the LOD dial per band; the archetypes are the same shapes at
 * every distance so a mass does not change identity as the player climbs.
 */

/** Gothic tower cluster: a spine of tapered towers, the tallest tipped. */
function towerCluster(pos, rand, sides) {
  const n = 4 + Math.floor(rand() * 3)
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2
    const rr = rand() * 0.24
    const r = 0.07 + rand() * 0.13
    const h = 0.34 + rand() * 0.58
    prism(pos, rand, {
      cx: Math.cos(a) * rr, cz: Math.sin(a) * rr, r,
      y0: -0.05 - rand() * 0.2, y1: h, sides,
      top: 0.42 + rand() * 0.3, jitter: 0.34, yaw: rand() * 3,
      apex: 0.1 + rand() * 0.3, tip: rand() < 0.55 ? 0.08 + rand() * 0.16 : 0,
      wobble: 0.18,
    })
  }
  // Needles: the thin verticals that give a tower cluster its gothic read and
  // its top-to-bottom line (§5, "always frame a vertical").
  for (let i = 0; i < 3; i++) {
    const a = rand() * Math.PI * 2
    const rr = 0.1 + rand() * 0.32
    prism(pos, rand, {
      cx: Math.cos(a) * rr, cz: Math.sin(a) * rr,
      r: 0.018 + rand() * 0.026,
      y0: 0.1 + rand() * 0.3, y1: 0.74 + rand() * 0.26, sides: Math.max(4, sides - 3),
      top: 0.3, jitter: 0.2, yaw: rand() * 3, apex: 0.05, tip: 0.05 + rand() * 0.09,
      wobble: 0.05,
    })
  }
}

/**
 * Hanging ruin chunk: a plateau over a fractured plinth, with drips.
 * §4.2 — "the underside is the opposite: jagged broken rock, irregular, with
 * drip-like spikes hanging beneath". One cone was never that.
 */
function hangingRuin(pos, rand, sides) {
  // The plateau — the only flat thing in the archetype.
  prism(pos, rand, {
    r: 0.42, y0: 0.42, y1: 0.72 + rand() * 0.24, sides,
    top: 0.88, jitter: 0.24, yaw: rand() * 3, apex: 0, wobble: 0.16,
  })
  // A narrower body under it, set back, so the plateau reads as an overhang.
  prism(pos, rand, {
    cx: (rand() - 0.5) * 0.1, cz: (rand() - 0.5) * 0.1,
    r: 0.33, y0: -0.05, y1: 0.46, sides,
    top: 1.25, jitter: 0.3, yaw: rand() * 3, apex: 0, wobble: 0.1,
  })
  // Broken outcrops around the rim: the notches that stop the plateau reading
  // as a disc.
  const k = 3 + Math.floor(rand() * 3)
  for (let i = 0; i < k; i++) {
    const a = rand() * Math.PI * 2
    prism(pos, rand, {
      cx: Math.cos(a) * 0.28, cz: Math.sin(a) * 0.28,
      r: 0.07 + rand() * 0.09,
      y0: 0.5, y1: 0.76 + rand() * 0.26, sides: Math.max(4, sides - 2),
      top: 0.5, jitter: 0.4, yaw: rand() * 3, apex: 0, tip: rand() < 0.4 ? 0.1 : 0,
      wobble: 0.3,
    })
  }
  // The drips. Long, thin, uneven, hanging to different depths.
  const d = 5 + Math.floor(rand() * 4)
  for (let i = 0; i < d; i++) {
    const a = rand() * Math.PI * 2
    const rr = rand() * 0.34
    prism(pos, rand, {
      cx: Math.cos(a) * rr, cz: Math.sin(a) * rr,
      r: 0.035 + rand() * 0.065,
      y0: -0.02, y1: 0.2, sides: Math.max(4, sides - 3),
      top: 0.55, jitter: 0.35, yaw: rand() * 3,
      apex: 0.3 + rand() * 0.58, wobble: 0.05,
    })
  }
}

/** Stepped ziggurat: setback slabs with antennae. The "built" silhouette. */
function slabStack(pos, rand, sides) {
  const steps = 3 + Math.floor(rand() * 2)
  // Step heights are drawn as WEIGHTS and normalised to a total, so a stack of
  // four never sums past the unit cell — the alternative (independent heights
  // and a clamp) silently flattens the top storey.
  const w = []
  for (let i = 0; i < steps; i++) w.push(0.7 + rand() * 0.6)
  const wsum = w.reduce((a, b) => a + b, 0)
  const total = 0.72 + rand() * 0.24
  let y = -0.1
  let r = 0.40
  const cx = (rand() - 0.5) * 0.10, cz = (rand() - 0.5) * 0.10
  const yaw = rand() * 3
  for (let i = 0; i < steps; i++) {
    const h = total * w[i] / wsum
    prism(pos, rand, {
      cx, cz, r, y0: y, y1: y + h, sides: 4,
      top: 0.98, jitter: 0.16, yaw, apex: i === 0 ? 0.28 + rand() * 0.4 : 0,
      wobble: 0.08,
    })
    y += h
    r *= 0.6 + rand() * 0.2
  }
  // A broken upper storey knocked off-axis, and two masts.
  prism(pos, rand, {
    cx: cx + (rand() - 0.5) * 0.14, cz: cz + (rand() - 0.5) * 0.14,
    r: r * 1.3, y0: y, y1: y + 0.1 + rand() * 0.18, sides: Math.max(4, sides - 2),
    top: 0.6, jitter: 0.5, yaw: yaw + 0.7, apex: 0, wobble: 0.4,
  })
  for (let i = 0; i < 2; i++) {
    prism(pos, rand, {
      cx: cx + (rand() - 0.5) * 0.3, cz: cz + (rand() - 0.5) * 0.3,
      r: 0.014 + rand() * 0.018,
      y0: y * 0.6, y1: 0.84 + rand() * 0.24, sides: 4,
      top: 0.35, jitter: 0.1, yaw: rand() * 3, apex: 0, tip: 0.05,
      wobble: 0.04,
    })
  }
}

/** Crystal shard cluster — the fragments, and the only place a tip is the point. */
function shardCluster(pos, rand, sides) {
  const n = 3 + Math.floor(rand() * 3)
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2
    const rr = rand() * 0.22
    prism(pos, rand, {
      cx: Math.cos(a) * rr, cz: Math.sin(a) * rr,
      r: 0.09 + rand() * 0.13,
      y0: -0.1 - rand() * 0.3, y1: 0.35 + rand() * 0.55,
      sides: Math.max(4, sides - 2),
      top: 0.3, jitter: 0.45, yaw: rand() * 3,
      apex: 0.15 + rand() * 0.35, tip: 0.08 + rand() * 0.15, wobble: 0.06,
    })
  }
}

const ARCHETYPES = {
  tower: towerCluster,
  ruin: hangingRuin,
  slab: slabStack,
  shard: shardCluster,
}

/**
 * Fail closed on the unit cell. `clearanceOf()` bounds an instance by the
 * cell, so a builder that wandered outside it would silently shrink the
 * measured clearance — the one direction a safety check may never be wrong in.
 */
function assertBounds(pos, name) {
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    const eps = 1e-4
    if (Math.abs(x) > 0.5 + eps || Math.abs(z) > 0.5 + eps
        || y < GEO_MIN_Y - eps || y > GEO_MAX_Y + eps) {
      throw new Error(`void backdrop: archetype '${name}' left the unit cell at `
        + `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) — clearanceOf() `
        + `bounds instances by that cell and would under-report clearance`)
    }
  }
}

/**
 * @param {keyof ARCHETYPES} kind
 * @param {number} sides how many faces around; the per-band LOD dial
 * @param {number} seed
 */
function ruinGeometry(kind, sides, seed) {
  const rand = rng(seed)
  const pos = []
  ARCHETYPES[kind](pos, rand, sides)
  assertBounds(pos, kind)
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
  varying vec3 vWorld;

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
    vWorld = world.xyz;

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
  uniform vec3 uGlintTint;   // theme.light.keyColor — the violet window/crystal light
  // x: extinction per metre, y: transmittance floor, z: inscatter gain,
  // w: body brightness.
  uniform vec4 uHazeParams;
  // x: storey/groove wavelength in metres, y: glint cell size in metres,
  // z: glint rarity (fraction of cells lit), w: glint brightness.
  uniform vec4 uDetail;

  varying vec3 vNormalW;
  varying float vDist;
  varying vec3 vDirW;
  varying float vSeed;
  varying vec3 vWorld;

  float scHash13(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

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

    // --- internal structure -------------------------------------------------
    // ADDED 2026-07-26. The review's exact words about the old layer: "no
    // internal structure, no windows, no fracture, no edge glow — literally
    // paper triangles". Geometry answered the silhouette half of that; this is
    // the surface half, and it is a shader rather than a texture because the
    // whole layer is one nonrepeating kilometre-wide field and a canvas would
    // have to be either enormous or obviously tiled.
    //
    // EVERY FEATURE HERE IS SIZED IN METRES, NOT IN UV, and sized ABOVE the
    // pixel it lands on: at 500-1000 m a 1600 px frame resolves roughly 1 m
    // per 3 px, so the grooves run at 9-14 m and the glint cells at 6-9 m.
    // Detail finer than that does not read as detail, it reads as noise that
    // crawls when the player moves — which is worse than the flat polygon it
    // replaced.

    // Per-face value break, from the quantised face normal. Costs nothing and
    // it alone stops adjacent facets of one mass arriving at the same value.
    float faceH = scHash13(floor(N * 6.0 + 0.5) + vSeed * 37.0);
    body *= 0.74 + 0.52 * faceH;

    // Storey grooves and panel breaks on the near-vertical faces — §4.1's
    // "flat-ish faces divided into rectangular panels by deep recessed
    // grooves". They are what makes a mass read as BUILT rather than as a rock
    // at this distance, and they are the only thing giving the eye a scale
    // reference out there.
    //
    // shade MULTIPLIES THE COMPOSITE, not the body, and it only ever
    // darkens. That is the whole reason it works: at these ranges the body is
    // 30% of the pixel and the inscatter is 70%, so grooves applied to the
    // body alone are invisible — the first version of this shader answered
    // that by winding the body brightness up until they showed, which is
    // exactly how the layer went pale. Bounded at 1.0 from above, a recess can
    // never come out lighter than the haze it sits in.
    float vert = 1.0 - abs(N.y);
    float storey = sin(vWorld.y * (6.2831 / uDetail.x) + faceH * 6.2831);
    float panel = sin(dot(vWorld.xz, vec2(N.z, -N.x)) * (6.2831 / (uDetail.x * 1.7)));
    float shade = 1.0
      - 0.26 * vert * smoothstep(0.35, 0.95, storey)
      - 0.16 * vert * smoothstep(0.55, 0.98, panel)
      - 0.10 * faceH;

    // Edge glow. A silhouette seen against lit haze picks up light around its
    // rim; without it a dark mass in front of a dark mass has no seam at all.
    // Narrow (^7) and faint: at ^4 it painted the whole width of every needle
    // and spire, which is a large part of what read as pale.
    float fres = pow(1.0 - abs(dot(N, vDirW)), 7.0);
    body += uSkyTint * fres * 0.09;

    // Fracture: thin emissive cracks, sparse, violet. §3's red stays out of
    // this — it is "the rarest and most intense colour" and a kilometre of
    // glowing red seams would spend the whole frame's punctuation budget.
    float seam = abs(sin(dot(vWorld, vec3(0.11, 0.29, 0.07)) + faceH * 11.0));
    body += uGlintTint * smoothstep(0.985, 1.0, seam) * 0.05;

    // --- the pinpricks ------------------------------------------------------
    // roadmap: "the far bands carry no light of their own... the reference has
    // pinpricks out there — distant sigils and crystal glints — and they are
    // most of what sells the scale". A sparse world-space cell grid: one cell
    // in ~1/uDetail.z carries a soft dot, coloured violet with a rare red.
    vec3 cell = vWorld / uDetail.y;
    vec3 id = floor(cell);
    float h = scHash13(id);
    if (h > 1.0 - uDetail.z) {
      vec3 f = fract(cell) - 0.5;
      float g = smoothstep(0.30, 0.04, length(f));
      float red = step(0.86, scHash13(id + 5.7));
      vec3 tint = mix(uGlintTint, uRimTint, red);
      body += tint * g * uDetail.w * (0.5 + h);
    }

    // --- the haze ----------------------------------------------------------
    // The inscatter is scVoidGradient, the SAME function the dome and the
    // aerial perspective evaluate.
    //
    // THE GAIN IS BELOW 1, AND THAT IS THE CORRECTION. It was 0.95 / 1.50 /
    // 1.85 with the far band deliberately LIGHTER than the dome, on the
    // reasoning that a far mass is mostly lit haze. That reasoning is sound in
    // a daylit valley and wrong here: the void's haze is lit from BELOW and
    // BEHIND by crystal and sigil-fire, so what the reference actually shows
    // at a kilometre is a dark spire standing in front of a glowing violet
    // volume — a silhouette, always darker than its surround, losing contrast
    // with distance but never crossing over. A layer authored lighter than the
    // sky is a fog bank with lumps in it (§8.3), and it looked like one.
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

    gl_FragColor = vec4((body * T + inscatter * (1.0 - T)) * shade, 1.0);
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
function pickKind(mix, rand) {
  if (typeof mix === 'string') return mix
  let r = rand()
  const keys = Object.keys(mix)
  for (const k of keys) {
    r -= mix[k]
    if (r <= 0) return k
  }
  return keys[keys.length - 1]
}

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
        kind: pickKind(band.mix, rand),
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
    sides: 10, seed: 0x7a1105,
    // The silhouette mix. Ruin chunks lead here because this is the band where
    // a dripping underside is still several pixels of profile.
    mix: { ruin: 0.42, tower: 0.32, slab: 0.26 },
    radius: [470, 600], y: [-430, 640],
    clusters: 17, per: [7, 13],
    spreadAng: 0.30, spreadRad: 80, spreadY: 120,
    width: [30, 78], spireOdds: 0.16, tilt: 0.05, drift: 0,
    // THE DARK RUNG, 0.55 of the dome it stands in front of.
    // This band has to be a SILHOUETTE and a silhouette is darker than its
    // background.
    haze: [0.0026, 0.05, 0.55, 0.050],
    // [groove wavelength m, glint cell m, glint rarity, glint brightness].
    detail: [9.0, 6.0, 0.030, 0.70],
  },
  {
    name: 'mid',
    sides: 8, seed: 0x2c9f31,
    mix: { tower: 0.44, ruin: 0.30, slab: 0.26 },
    radius: [690, 850], y: [-640, 760],
    clusters: 19, per: [8, 15],
    spreadAng: 0.36, spreadRad: 120, spreadY: 170,
    width: [34, 92], spireOdds: 0.34, tilt: 0.04, drift: 0,
    // 0.66. Contrast is falling with distance — but toward the haze value from
    // BELOW, never through it. That is what aerial perspective does to a dark
    // object, and doing it in the other direction is what made the old far
    // band pale origami.
    haze: [0.0017, 0.05, 0.66, 0.042],
    detail: [11.0, 7.5, 0.026, 0.90],
  },
  {
    name: 'far',
    // 7-gon, up from 6. The saving from 6 was never worth having — the whole
    // layer is single-digit percent of the frame's triangles — and a hexagon
    // is the one n-gon whose silhouette is unmistakably a hexagon.
    sides: 7, seed: 0x51d7b3,
    mix: { tower: 0.46, ruin: 0.28, slab: 0.26 },
    // The outer edge is bounded by the CAMERA FAR PLANE (1200 m, src/main.js)
    // measured from the far side of the course, not by taste: a band that
    // clips against the frustum's back would appear and disappear as the
    // player crossed the shaft. 880..1000 m of ring plus 58 m of spread plus
    // 142 m of course radius is 1200 m exactly.
    radius: [880, 1000], y: [-900, 880],
    clusters: 24, per: [9, 17],
    spreadAng: 0.42, spreadRad: 58, spreadY: 300,
    // NOTE the y floor above: -900 m. The bands run far BELOW the course as
    // well as above it, and that is the `plunge` shot's whole read — airborne
    // over the shaft looking down, the depth has to keep going. A backdrop
    // that stops at the kill plane makes a bottomless void look like a pit
    // with a lid on the bottom of the frame.
    width: [60, 180], spireOdds: 0.38, tilt: 0.03, drift: 0,
    // 0.78 — §5's "washed almost to the fog colour", approached from the dark
    // side. Almost, not past: this is the rung that was authored at 1.26 and
    // turned the top of every frame into pale flat origami.
    haze: [0.0011, 0.04, 0.78, 0.035],
    // Bigger features and brighter glints out here, because everything is
    // smaller in the frame: at a kilometre a 9 m groove is 2 px and crawls.
    detail: [15.0, 10.0, 0.022, 1.20],
  },
]

/**
 * The drifting fragments (§5, "floating fragments"; §4.5, "the void has a
 * current"). Folded into the near band's mesh rather than given their own, so
 * they cost instances and not a draw call.
 */
const FRAGMENTS = {
  mix: 'shard',
  radius: [440, 560], y: [-380, 560],
  clusters: 26, per: [5, 10],
  spreadAng: 0.30, spreadRad: 70, spreadY: 170,
  width: [2.5, 7.5], spireOdds: 0.18, tilt: 0.9, drift: 7,
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
    // Every archetype is authored inside the unit cell and `assertBounds()`
    // throws if one is not, so GEO_MIN_Y..GEO_MAX_Y bounds any instance
    // whichever silhouette it drew.
    const y0 = it.y + GEO_MIN_Y * it.h - (it.drift || 0)
    const y1 = it.y + GEO_MAX_Y * it.h + (it.drift || 0)

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
  bands[0].items.push(...bandInstances(FRAGMENTS, rand))
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
    const makeMaterial = (haze, detail) => {
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
          uGlintTint: { value: new THREE.Color(L.keyColor) },
          uDetail: { value: new THREE.Vector4(...detail) },
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

    this.instances = 0
    this.triangles = 0

    for (const { band, items } of bands) {
      // ONE MESH PER (BAND, ARCHETYPE). An InstancedMesh carries one geometry,
      // so a vocabulary of silhouettes costs a draw call per silhouette per
      // band — 10 calls where there were 3, against a frame that already
      // issues 85-119. That is the price of the thing the review says is
      // missing, and it is cheap.
      const kinds = [...new Set(items.map((it) => it.kind))]
      for (const kind of kinds) {
        const group = items.filter((it) => it.kind === kind)
        const geo = ruinGeometry(kind, band.sides, band.seed ^ (kind.charCodeAt(0) * 2654435761))
        const material = makeMaterial(band.haze, band.detail)
        this.materials.push(material)
        const mesh = new THREE.InstancedMesh(geo, material, group.length)
        const seeds = new Float32Array(group.length)
        const drifts = new Float32Array(group.length)

        group.forEach((it, i) => {
          e.set(it.tilt, it.yaw, it.tilt * 0.6)
          q.setFromEuler(e)
          // The archetypes are authored with their BODY base at y = 0, so an
          // instance's y is the underside of its mass and its broken points
          // and drips hang below that.
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

        // The instances span a kilometre; the base geometry's bound describes
        // a 1 m cell at the origin. InstancedMesh computes its own bounds from
        // the matrices, but only on demand — do it once, up front, so the
        // culler has the truth from the first frame instead of throwing the
        // band away.
        mesh.computeBoundingSphere()
        // Like the sky sphere: this must read as infinitely far. A
        // contact-shadow ray that hit a backdrop mass would shadow a third of
        // the frame.
        mesh.userData.scNoPrepass = true
        mesh.castShadow = false
        mesh.receiveShadow = false
        // AFTER the sky dome (renderOrder 0, and it writes no depth), so the
        // far band is not clipped by the dome's own 900 m radius — the outer
        // ring sits past it on purpose. Before the additive layers, which are 3.
        mesh.renderOrder = 1
        mesh.name = `void-backdrop-${band.name}-${kind}`
        scene.add(mesh)
        this.meshes.push(mesh)

        this.instances += group.length
        this.triangles += group.length * (geo.getAttribute('position').count / 3)
      }
    }
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
