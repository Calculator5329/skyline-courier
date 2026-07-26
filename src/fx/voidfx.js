import * as THREE from 'three'

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
 *    read height". They are therefore placed along the route's own axis at
 *    known lateral offsets rather than scattered for decoration, and
 *    `voidBeamSites()` is exported so other systems (the motes below, anything
 *    later) can agree about where the light in this world is.
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

/** The course runs along +X from the terrace at x=4 to the tower at x=222. */
const ROUTE_LENGTH = 250

/**
 * Deterministic PRNG. The beams are landmarks, so their positions have to be
 * the same on every boot and in every capture — a shot set whose composition
 * changes run to run cannot be used to tell whether a change altered the
 * picture (see the note on `clock` in main.js's __SHOT__).
 */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * Where the beams stand, as plain data.
 *
 * Exported rather than private because the motes in world.js cluster around
 * them — §4.5 asks for dust "denser near crystals and beams", and dust that is
 * dense in a place with no light in it is just noise.
 *
 * The lateral offsets are the load-bearing part. |z| is never under 13 m: the
 * route corridor and everything the player can stand on live inside that, and
 * a column of light passing through a landing platform reads as a bug however
 * pretty it is. Beyond that the offsets are deliberately bimodal — a near band
 * at 13-26 m that frames the route (§5: "always frame a vertical") and a far
 * band at 40-90 m that gives the middle distance something to be measured
 * against.
 *
 * @returns {{x:number,y:number,z:number,height:number,radius:number,
 *            color:[number,number,number],seed:number}[]}
 */
export function voidBeamSites() {
  const rand = rng(0x5c0de1)
  const sites = []

  // Red is the rarest and most intense colour in the reference and §3 says it
  // "must stay rare" — so the beams are red/magenta and almost nothing else in
  // the theme is. Authored well above 1.0: bloom thresholds at 0.78 on the MAX
  // channel post-exposure, and a saturated red at 1.0 has a max channel of
  // exactly 1.0, which after a two-stop-down void exposure would not bloom at
  // all. These are the numbers that make the beam a light source rather than a
  // red line.
  const PALETTE = [
    [46.0, 2.2, 8.0],    // #FF2D55, the signature
    [34.0, 1.2, 4.4],    // #E11D48, deeper
    [40.0, 2.6, 22.0],   // magenta, the rarer variant
  ]

  // 12, down from the 15 this started at. Measured by looking: at 15 the
  // terrace shot came back with ten beams across it and the void stopped
  // reading as dark punctuated by red and started reading as a harp. §3 is
  // explicit that red "is the rarest and most intense colour and it must stay
  // rare... If red is everywhere, the image loses its focal points."
  const COUNT = 12
  for (let i = 0; i < COUNT; i++) {
    // Stratified along X so the course never has a long stretch with no
    // vertical in it — the landmark job fails the moment there is a gap.
    const x = ((i + 0.15 + rand() * 0.7) / COUNT) * ROUTE_LENGTH - 12
    const near = i % 3 !== 0
    const mag = near ? 13 + rand() * 13 : 40 + rand() * 50
    const z = (rand() < 0.5 ? -1 : 1) * mag

    // Tens of metres, and the near ones taller: a beam that terminates inside
    // the frame has a top, and a top is a horizon for the eye. The near band
    // runs from below the kill plane to above the finish (y = 88) so it always
    // exits the frame at both ends.
    const height = near ? 190 + rand() * 90 : 130 + rand() * 80
    const y = near ? -95 - rand() * 30 : -70 - rand() * 40

    sites.push({
      x, y, z, height,
      // Thin. The far band thinner still, so distance is carried by width as
      // well as by haze.
      radius: near ? 0.42 + rand() * 0.22 : 0.26 + rand() * 0.14,
      color: PALETTE[i % PALETTE.length],
      seed: rand() * Math.PI * 2,
    })
  }
  return sites
}

const VERT = /* glsl */`
  attribute vec3 aBase;      // world position of the beam's foot
  attribute vec3 aBeam;      // x half-width, y height, z seed
  attribute vec3 aColor;
  uniform vec2 uHaze;        // x: extinction per metre, y: near-fade radius
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vSeed;
  varying float vAtten;

  void main() {
    vUv = uv;
    vColor = aColor;
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
    vAtten = exp(-dist * uHaze.x);
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
    // has a cap, and a cap at a consistent height across fifteen instances
    // would read as a floor or a ceiling — which §3 rules out by name.
    float ends = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.80, vUv.y);

    // Energy travelling up the column. Slow, low-contrast, and a function of
    // WORLD height (vUv.y * the instance's own height would be better still,
    // but the visible period only has to beat the eye, not a ruler). The
    // per-instance seed stops fifteen columns pulsing in unison, which is the
    // difference between a living void and a screensaver.
    float pulse = 0.86 + 0.14 * sin(uTime * 1.6 - vUv.y * 26.0 + vSeed);

    // The core goes white-hot rather than more red. A saturated emissive that
    // simply gets brighter stays the same hue and reads as a decal; a real
    // light source desaturates toward its own centre, and that gradient from
    // white through magenta to red across two metres of screen is most of what
    // sells these as energy rather than as paint.
    vec3 c = vColor * body + vec3(1.0, 0.62, 0.78) * core * 26.0;

    gl_FragColor = vec4(c * ends * pulse * vAtten, 1.0);
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
    const aBeam = new Float32Array(sites.length * 3)
    const aColor = new Float32Array(sites.length * 3)
    sites.forEach((s, i) => {
      aBase[i * 3] = s.x; aBase[i * 3 + 1] = s.y; aBase[i * 3 + 2] = s.z
      aBeam[i * 3] = s.radius; aBeam[i * 3 + 1] = s.height; aBeam[i * 3 + 2] = s.seed
      aColor[i * 3] = s.color[0]; aColor[i * 3 + 1] = s.color[1]; aColor[i * 3 + 2] = s.color[2]
    })
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(aBase, 3))
    geo.setAttribute('aBeam', new THREE.InstancedBufferAttribute(aBeam, 3))
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(aColor, 3))
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
  }

  update(time) {
    this.material.uniforms.uTime.value = time
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
