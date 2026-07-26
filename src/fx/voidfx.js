import * as THREE from 'three'
import { VoidLife } from './voidlife.js'

/**
 * VERTICAL ENERGY BEAMS — `docs/art-direction-void.md` §4.4.
 *
 * "Thin, intensely bright red/magenta columns running vertically through the
 * void, tens of metres long, heavily bloomed. Long, straight, and very thin —
 * the contrast between their thinness and their brightness is the effect."
 *
 * THREE THINGS THIS FILE IS TRYING TO GET RIGHT, in the order they matter.
 *
 * 1. THE CONTRAST, NOT THE BRIGHTNESS. A fat bright column is a fog bank; a
 *    thin dim one is a wire. What reads as energy is a core one or two pixels
 *    wide sitting three orders of magnitude above the rock beside it, with the
 *    bloom pyramid — not the geometry — supplying every pixel of apparent
 *    width. So the quads here are 0.5-1.1 m across and their cores are authored
 *    at 30-70 in linear light, far above display white, and the width you
 *    actually see in the frame is bloom. Widening the quad to "make them more
 *    visible" is the one change guaranteed to destroy the effect.
 *
 * 2. THEY ARE LEVEL DESIGN. §4.4 again: "a gift to gameplay: unmissable
 *    vertical landmarks in a course whose whole problem is that the player must
 *    read height". They are therefore placed against the course's own islands
 *    rather than scattered for decoration, and `voidBeamSites()` is exported so
 *    other systems (the motes below, anything later) can agree about where the
 *    light in this world is.
 *
 * 2b. THERE ARE SIX OF THEM AND THEY ARE ALL DIFFERENT. Ethan, 2026-07-25,
 *    with the build beside the reference: "there are roughly a dozen in frame,
 *    all similar, all pin-sharp, and several rake diagonally so they converge
 *    like searchlights." Three separate faults, and the table below answers
 *    each one by name:
 *
 *    - COUNT. Twelve became six. §3: red "is the rarest and most intense colour
 *      and it must stay rare... if red is everywhere, the image loses its focal
 *      points." Twelve beams is not punctuation, it is a texture.
 *    - SAMENESS. They were drawn from one distribution with one narrow width
 *      range, so twelve near-identical columns arrived at near-identical
 *      brightness. Every site now names its own length, base, radius,
 *      intensity and haze, and no two are close.
 *    - THE RAKE. The beams were, and are, geometrically plumb — but they were
 *      laid out along +X across 250 m for a course that no longer exists (the
 *      void runs +Y up a shaft around the origin), so most of them stood off in
 *      empty space and were only ever seen end-on and far away, where
 *      perspective turns a row of parallel verticals into converging
 *      searchlights. Standing them AROUND the shaft at route azimuths is what
 *      actually fixes the read: a beam seen across the shaft is a plumb line,
 *      and §5 gets its framing vertical from it.
 *
 * 3. ONE DRAW CALL. Instanced, frustum culling disabled (the instances span the
 *    whole world, so a bounding sphere around the base mesh is a lie that pops
 *    columns in and out at the screen edge), additive, no depth write. The
 *    whole system is one geometry, one material, one draw.
 *
 * COLLIDERS: deliberately none, and this is not a violation of CLAUDE.md rule
 * 2. That rule binds *surfaces* — a thing the player can stand on, run along or
 * bump into must own its collider. A beam is volumetric light, in the same
 * category as the motes and the grapple line: additively blended, depth-write
 * off, and passed through by design. §6 is explicit that crystal and energy are
 * "never a hazard".
 */

/**
 * Red is the rarest and most intense colour in the reference and §3 says it
 * "must stay rare" — so the beams are red/magenta and almost nothing else in
 * the theme is. Authored well above 1.0: bloom thresholds at 0.78 on the MAX
 * channel post-exposure, and a saturated red at 1.0 has a max channel of
 * exactly 1.0, which after a two-stop-down void exposure would not bloom at
 * all. These are the numbers that make the beam a light source rather than a
 * red line.
 */
const SIGNATURE = [46.0, 2.2, 8.0]    // #FF2D55, the signature
const DEEP = [34.0, 1.2, 4.4]         // #E11D48, deeper
const MAGENTA = [40.0, 2.6, 22.0]     // the rarer, cooler variant

/**
 * WHERE THE BEAMS STAND — a table, not a loop.
 *
 * A loop over a PRNG is what produced twelve interchangeable columns. Six
 * hand-placed sites is fewer lines than the generator was, every one of them
 * marks something, and no two share a silhouette. That is the whole change.
 *
 * THE COORDINATES ARE READ OFF `src/levels/void.js`, not invented — that file
 * belongs to another lane and must not be edited, so its spiral was evaluated
 * and the results are quoted here. `tools/shots.mjs` already uses this
 * convention for the shot cameras. The four route beams stand on the RADIAL
 * LINE through a branch island, pushed out past the great wall that stands
 * beyond it (`r + 15`, 26 m deep, so its outer face is at `r + 28`):
 *
 *   hero-2   r 34.6  ang 2.410  y  20.0   wall to r 62.6   beam at r 75.6
 *   hero-6   r 44.2  ang 4.075  y  73.7   wall to r 72.2   beam at r 85.2
 *   hero-10  r 54.7  ang 5.203  y 104.9   wall to r 82.7   beam at r 95.7
 *   hero-18  r 79.5  ang 7.767  y 190.8   wall to r 107.5  beam at r 120.5
 *
 * Those four are the islands the side paths branch from (`BRANCH_AT` in
 * void.js), so a beam is a "there is a decision here" marker as well as a
 * height marker. And the 13 m of clearance past the wall's outer face is the
 * composition, not just safety: §5's "silhouette against glow" wants dark mass
 * backed by something brighter, and a great wall with a red column standing
 * just behind it is that rule built into the level rather than lit into it.
 *
 * The last two are far — out in the backdrop's near band (`fx/voidbackdrop.js`)
 * — and exist so the middle distance has a vertical in it. They are the
 * "washed by fog at distance" end of the variation Ethan asked for, and they
 * are why `haze` is per-site: distance alone dims them, and these are dimmed
 * further so they read as veiled rather than merely small.
 *
 * @returns {{x:number,y:number,z:number,height:number,radius:number,
 *            color:[number,number,number],intensity:number,haze:number,
 *            seed:number,note:string}[]}
 */
const SITES = [
  {
    // The establishing vertical. Visible from the plaza (VOID_SHOTS.ascent
    // looks straight up from there), the brightest and the thickest, and it
    // runs from well below the kill plane to well above the spire so it never
    // shows an end.
    x: -56.3, y: -150, z: 50.5, height: 470,
    radius: 0.62, color: SIGNATURE, intensity: 1.0, haze: 1.0, seed: 0.0,
    note: 'hero-2 / the first branch — the establishing vertical from the floor',
  },
  {
    // Deeper red, thinner, and it STOPS below the top of the course: its fade
    // finishes around y 250, so from the spire it is a column you have climbed
    // past. That is a height cue no uniform beam can give.
    x: -50.7, y: -110, z: -68.5, height: 360,
    radius: 0.38, color: DEEP, intensity: 0.72, haze: 1.0, seed: 1.9,
    note: 'hero-6 / the second branch — mid-climb, deeper and thinner',
  },
  {
    // The magenta one. One of six, which is what keeps it rare enough to be
    // the odd one out rather than a second colour scheme.
    x: 45.1, y: -60, z: -84.4, height: 430,
    radius: 0.52, color: MAGENTA, intensity: 0.88, haze: 1.0, seed: 3.6,
    note: 'hero-10 / the third branch — the magenta variant',
  },
  {
    // The tallest and the highest-based: it starts above the plaza entirely,
    // so from the floor it is a column hanging in the air with nothing under
    // it, and from the upper course it is the vertical that frames the finish.
    x: 10.5, y: 40, z: 120.0, height: 420,
    radius: 0.46, color: SIGNATURE, intensity: 0.94, haze: 1.0, seed: 5.1,
    note: 'hero-18 / the last branch — hangs above the floor, frames the finish',
  },
  {
    // --- the far pair -----------------------------------------------------
    // Out among the backdrop's near band. Wide in metres and thin on screen —
    // 2.2 m at 335 m is about eight pixels at 1600x900, which after the haze
    // below is a filament. `haze` doubles the extinction they see so they sit
    // BEHIND the near band's ruins in value as well as in depth.
    x: 166.7, y: -240, z: 290.6, height: 620,
    radius: 2.2, color: DEEP, intensity: 2.4, haze: 2.0, seed: 2.4,
    note: 'far band — a vertical in the middle distance, heavily veiled',
  },
  {
    x: 398.8, y: -300, z: -160.8, height: 780,
    radius: 3.1, color: SIGNATURE, intensity: 3.2, haze: 2.4, seed: 4.4,
    note: 'far band — the deepest vertical, almost fog',
  },
]

/**
 * Where the beams stand, as plain data.
 *
 * Exported rather than private because the motes in world.js cluster around
 * them — §4.5 asks for dust "denser near crystals and beams", and dust that is
 * dense in a place with no light in it is just noise. The shape of the returned
 * object is the contract with world.js and has not changed; `intensity`,
 * `haze` and `note` are additions, and a consumer that ignores them still gets
 * the same fields it always did.
 */
export function voidBeamSites() {
  return SITES.map((s) => ({ ...s }))
}

const VERT = /* glsl */`
  attribute vec3 aBase;      // world position of the beam's foot
  // x half-width, y height, z seed, w per-site haze multiplier. The multiplier
  // is what lets two beams at the same distance read as different amounts of
  // "buried in the fog" — Ethan asked for the occlusion to VARY, and distance
  // alone gives one answer per position.
  attribute vec4 aBeam;
  // xyz: colour premultiplied by the site's own intensity, so brightness
  // varies per beam without a second palette. w: that intensity on its own,
  // because the white-hot core in the fragment shader is an ADDITIVE term and
  // would otherwise blaze at full strength on a beam authored to be dim — the
  // exact way a "vary the brightness" change gets silently undone.
  attribute vec4 aColor;
  uniform vec2 uHaze;        // x: extinction per metre, y: near-fade radius
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vSeed;
  varying float vAtten;
  varying float vHot;

  void main() {
    vUv = uv;
    vColor = aColor.rgb;
    vHot = aColor.a;
    vSeed = aBeam.z;

    // Billboard about the WORLD Y AXIS only, never about the view axis. A
    // full camera-facing billboard tips the column as the player pitches up,
    // and the one thing a vertical landmark may never do is stop being
    // vertical — §5 and §6 both hang off these reading as plumb lines.
    vec3 toCam = cameraPosition - aBase;
    toCam.y = 0.0;
    // Degenerate only if the camera is exactly on the beam's axis, where the
    // quad is edge-on and invisible anyway; the epsilon keeps the normalize
    // from producing NaN and painting the screen.
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(toCam + vec3(1e-4, 0.0, 0.0))));

    vec3 world = aBase
      + right * (position.x * 2.0 * aBeam.x)
      + vec3(0.0, (position.y + 0.5) * aBeam.y, 0.0);

    // --- the beams waver -----------------------------------------------------
    //
    // A pillar of energy is not a rigid rod: it leans and settles like a column
    // of heat, the head free and the foot all but anchored. The amplitude grows
    // as h01² so the base barely moves and the top drifts — a reed, not a
    // pendulum — and it rides the site's own width so a thin beam wavers less in
    // metres than a fat one. Gated to zero at t=0 by eInV below, so a frozen
    // acceptance shot keeps the exact plumb geometry §5 hangs its framing on;
    // the waver only exists in motion, which is the only thing a still frame
    // cannot see. Vertex work, so on a fill-bound renderer it is free.
    float eInV = smoothstep(0.0, 2.0, uTime);
    float h01 = position.y + 0.5;
    float swayAmp = aBeam.x * (0.2 + h01 * h01 * 2.6) * eInV;
    world += right * sin(uTime * 0.47 + vSeed * 5.0 + h01 * 2.3) * swayAmp * 0.5;
    world.x += sin(uTime * 0.31 + vSeed * 3.1 + h01 * 1.7) * swayAmp * 0.35;
    world.z += cos(uTime * 0.29 + vSeed * 2.3 + h01 * 1.9) * swayAmp * 0.35;

    // --- the beams live in the fog too -------------------------------------
    //
    // Additive geometry does not go through render/patch.js's aerial
    // perspective, so without this a beam 300 m away arrives at exactly the
    // brightness of one 20 m away. That is not a small cheat in this theme: §5
    // puts the entire depth read on aerial perspective, and a set of landmarks
    // immune to it flattens the three bands back into one — the far beams stop
    // being far and the frame becomes a picture of some lines.
    //
    // Extinction only, no inscatter: a light source seen through haze loses its
    // own light to scattering, and what the haze scatters back is already being
    // drawn by the dome behind it.
    float dist = length(cameraPosition - world);
    vAtten = exp(-dist * uHaze.x * aBeam.w);
    // ...and faded out at point-blank range. A 200 m column passing within a
    // couple of metres of the eye fills a third of the screen with clipped
    // white, which measures as a blown frame and reads as a bug. Distance is
    // taken to the beam's AXIS rather than to the quad, so the fade is a
    // cylinder around the column and does not pop as the billboard turns.
    vec2 axial = cameraPosition.xz - aBase.xz;
    vAtten *= smoothstep(0.0, uHaze.y, length(axial));

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const FRAG = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vSeed;
  varying float vAtten;
  varying float vHot;

  void main() {
    // Cross-section. Two profiles superimposed, and the gap between their
    // exponents IS the look: a wide soft body that gives the column presence,
    // and a core an order of magnitude tighter that is what actually clips and
    // feeds the bloom pyramid. One profile alone gives either a soft red smear
    // or a hard aliased line.
    float x = abs(vUv.x * 2.0 - 1.0);
    float body = pow(max(1.0 - x, 0.0), 2.2);
    float core = pow(max(1.0 - x, 0.0), 14.0);

    // Fade both ends into the void over a long ramp. A beam that simply stops
    // has a cap, and a cap at a consistent height across six instances would
    // read as a floor or a ceiling — which §3 rules out by name. The ramps are
    // deliberately unequal: the foot fades over 16% of the column and the head
    // over 20%, so even a beam whose top IS inside the frame (site 2 finishes
    // below the spire on purpose) ends as a dissolve rather than as an edge.
    float ends = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.80, vUv.y);

    // Energy travelling up the column. Slow, low-contrast, and a function of
    // WORLD height (vUv.y * the instance's own height would be better still,
    // but the visible period only has to beat the eye, not a ruler). The
    // per-instance seed stops six columns pulsing in unison, which is the
    // difference between a living void and a screensaver.
    float pulse = 0.86 + 0.14 * sin(uTime * 1.6 - vUv.y * 26.0 + vSeed);

    // Everything below is gated to zero at t=0 so the frozen shot is unchanged;
    // it is the LIVING behaviour the brief asks for and a still frame can never
    // show. None of it is fast enough to strobe — the highest rate here is
    // 2.7 rad/s, a period of over two seconds.
    float eIn = smoothstep(0.0, 2.0, uTime);

    // A slow overall gutter — the whole column flaring and dropping like a flame
    // in a draught, per-seed so no two beams gutter together. This is the
    // flicker the beams were missing: they were pin-static in brightness.
    float flick = 1.0 + eIn * 0.07 * (sin(uTime * 0.9 + vSeed * 4.0)
                                    + 0.5 * sin(uTime * 2.7 + vSeed * 1.3));

    // A second, slower band sliding DOWN the length, so brightness varies along
    // the beam and not only across its cross-section — knots of energy travelling
    // through the column rather than a uniformly lit rod.
    float band = 1.0 + eIn * 0.12 * sin(uTime * 0.8 - vUv.y * 7.0 + vSeed * 2.0);

    // The core goes white-hot rather than more red. A saturated emissive that
    // simply gets brighter stays the same hue and reads as a decal; a real
    // light source desaturates toward its own centre, and that gradient from
    // white through magenta to red across two metres of screen is most of what
    // sells these as energy rather than as paint.
    vec3 c = vColor * body + vec3(1.0, 0.62, 0.78) * core * 26.0 * vHot;

    gl_FragColor = vec4(c * ends * pulse * flick * band * vAtten, 1.0);
  }
`

export class VoidFX {
  /**
   * @param {THREE.Scene} scene
   * @param {{x:number,y:number,z:number,height:number,radius:number,
   *          color:number[],seed:number}[]} sites
   */
  constructor(scene, sites = voidBeamSites()) {
    this.sites = sites

    const base = new THREE.PlaneGeometry(1, 1)
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = base.index
    geo.attributes.position = base.attributes.position
    geo.attributes.uv = base.attributes.uv
    geo.instanceCount = sites.length

    const aBase = new Float32Array(sites.length * 3)
    const aBeam = new Float32Array(sites.length * 4)
    const aColor = new Float32Array(sites.length * 4)
    sites.forEach((s, i) => {
      const k = s.intensity != null ? s.intensity : 1
      aBase[i * 3] = s.x; aBase[i * 3 + 1] = s.y; aBase[i * 3 + 2] = s.z
      aBeam[i * 4] = s.radius; aBeam[i * 4 + 1] = s.height
      aBeam[i * 4 + 2] = s.seed; aBeam[i * 4 + 3] = s.haze != null ? s.haze : 1
      aColor[i * 4] = s.color[0] * k
      aColor[i * 4 + 1] = s.color[1] * k
      aColor[i * 4 + 2] = s.color[2] * k
      aColor[i * 4 + 3] = k
    })
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(aBase, 3))
    geo.setAttribute('aBeam', new THREE.InstancedBufferAttribute(aBeam, 4))
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 4))
    base.dispose()

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        // x: extinction per metre. 0.0034 is the void theme's own aerial
        // density (src/theme.js), quoted here rather than imported because a
        // beam is not a surface and must not acquire the whole height-
        // integrated model just to be dimmed. y: the near-fade radius in
        // metres.
        uHaze: { value: new THREE.Vector2(0.0034, 9.0) },
      },
      transparent: true,
      // Additive and depth-write off, like every other light in this project
      // that is not a surface. Depth TEST stays on so a beam behind a ruin is
      // occluded by it — that occlusion is what puts the beams in the space
      // rather than on the lens, and it is what makes a dark silhouette read
      // against them (§5, "silhouette against glow").
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // The dome is drawn with depthWrite off and no fog; these must not be
      // hazed by scene.fog either, or the aerial perspective would be applied
      // twice to something that is not a surface.
      fog: false,
    })

    this.mesh = new THREE.Mesh(geo, this.material)
    // The instances span 250 m of course and 200 m of height; the base
    // geometry's bounding sphere describes a 1 m quad at the origin, so the
    // culler would throw the whole batch away the moment the origin left the
    // frustum. One draw call is cheap enough that culling it is not worth
    // maintaining a correct bound for.
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
    this.mesh.name = 'void-beams'
    scene.add(this.mesh)

    // The emissive breath — the crystals and wall-sigils, made to live. It has
    // to be constructed AND ticked by something the frame loop already drives,
    // and VoidFX is that thing: it is the void-only system main.js already
    // updates every frame (`voidFX?.update(now)`), so folding VoidLife in here
    // animates the theme's static emissives without any new wiring in main.js —
    // and without touching the skyline theme, which never builds a VoidFX at
    // all. See src/fx/voidlife.js for what it patches and the rules it obeys.
    this.life = new VoidLife(scene)
  }

  update(time) {
    this.material.uniforms.uTime.value = time
    this.life.update(time)
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.life.dispose()
  }
}
