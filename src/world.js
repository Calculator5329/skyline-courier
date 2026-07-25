import * as THREE from 'three'
import { PALETTE } from './materials.js'

/**
 * Sky, light, and atmosphere.
 *
 * Clockwork Garden's last playtest correction was blunt about this: a painted
 * backdrop card is not a sky, because its edge appears the moment the camera
 * turns. So the sky here is a real gradient shader on a sphere that the camera
 * can never reach the edge of, depth is carried by fog and by genuine distant
 * geometry, and the sun is a shaded disc in that gradient rather than a sprite.
 */

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const SKY_FRAG = /* glsl */`
  varying vec3 vDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uTime;

  // --- value noise / fbm, for the cloud deck --------------------------------
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(17.3, 5.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 sunDir = normalize(uSunDir);
    float sun = max(dot(d, sunDir), 0.0);

    // Vertical gradient. The horizon band is deliberately tight and very warm
    // and the zenith only barely blue — at golden hour the sky is mostly
    // light, and a wide blue wash immediately reads as midday.
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));

    // Warm the whole sky toward the sun's azimuth, not just the disc. This is
    // what makes the light feel directional when you turn to face it.
    sky += uSunColor * pow(sun, 3.0) * 0.14;
    sky += uSunColor * pow(sun, 1.2) * 0.05 * smoothstep(0.55, 0.0, abs(h));

    // --- the cloud sea ------------------------------------------------------
    // We are above a deck of cloud, so everything below the horizon is bright
    // rather than dark. Intersecting the view ray with a plane below the play
    // space gives real perspective compression: cloud detail crowds toward the
    // horizon exactly the way it should, and it costs one divide.
    if (h < -0.008) {
      float t = -1.0 / h;                       // distance to the deck
      vec2 cp = d.xz * t * 0.055;
      cp += vec2(uTime * 0.004, uTime * 0.0022);

      float n = fbm(cp);
      n = n * 0.62 + fbm(cp * 2.7 + n) * 0.38;  // domain warp: billows, not blobs

      // Fade detail out toward the horizon, where the deck is nearly edge-on
      // and any texture at all turns into aliasing.
      float detail = smoothstep(0.0, 0.26, -h);
      float puff = smoothstep(0.34, 0.78, n) * detail;

      // Cloud tops catch the low sun on the side facing it.
      vec3 lit = mix(uGround, uSunColor, 0.42);
      vec3 shade = uGround * 0.80;
      vec3 cloud = mix(shade, lit, puff * (0.45 + 0.55 * pow(sun, 0.8)));

      // Silver lining where the sun rakes across the tops.
      cloud += uSunColor * pow(sun, 6.0) * puff * 0.5;

      sky = mix(sky, cloud, smoothstep(0.0, 0.10, -h));
    }

    // The disc last, so nothing washes it out.
    sky += uSunColor * pow(sun, 900.0) * 5.0;
    sky += uSunColor * pow(sun, 60.0) * 0.35;

    gl_FragColor = vec4(sky, 1.0);
  }
`

export function buildWorld(scene, renderer) {
  // Golden hour: the sun sits LOW. This single number does more for the look
  // than any shader in the project — a high sun flattens everything into
  // top-down midday light and no amount of grading recovers the rim-lit,
  // long-shadowed read the reference depends on.
  const sunDir = new THREE.Vector3(-0.62, 0.17, 0.77).normalize()
  const horizon = new THREE.Color(0xffd9a4)

  // --- sky --------------------------------------------------------------
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 32, 20),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(0x6f9fc8) },
        uHorizon: { value: horizon },
        // "Ground" is the cloud deck, so it is BRIGHT. Everything below the
        // horizon in this world is luminous cloud, never dark earth.
        uGround: { value: new THREE.Color(0xf6e0c0) },
        uSunDir: { value: sunDir },
        uSunColor: { value: new THREE.Color(0xffd9a0) },
        uTime: { value: 0 },
      },
    }),
  )
  sky.name = 'sky'
  scene.add(sky)

  // Fog is the depth cue that sells altitude. It is bright and warm, so
  // distant islands LIGHTEN into golden haze rather than darkening into
  // murk — that direction of falloff is the difference between "far away
  // and very high up" and "dirty".
  scene.fog = new THREE.FogExp2(0xffdcae, 0.0052)

  // --- light ------------------------------------------------------------
  // Warm key against cool green-tinted ambient. That split is the defining
  // feature of the reference; a neutral-grey ambient kills it instantly.
  // Sky term is a warm gold (bounce off cloud tops is unusually strong here,
  // because the "ground" is a sunlit cloud deck), ground term a mossy green.
  const hemi = new THREE.HemisphereLight(0xffd9ab, 0x5c7048, 1.15)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xffca7d, 3.1)
  sun.position.copy(sunDir).multiplyScalar(60)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0008
  sun.shadow.normalBias = 0.035
  const cam = sun.shadow.camera
  // A single tight frustum that follows the player — effectively one cascade.
  // The full cascaded setup is a capability-phase item, not a slice blocker.
  cam.left = -42; cam.right = 42; cam.top = 42; cam.bottom = -42
  cam.near = 1; cam.far = 190
  cam.updateProjectionMatrix()
  scene.add(sun)
  scene.add(sun.target)

  // A cool fill from the opposite side keeps shadowed faces readable, which
  // matters more than realism when the player is reading a route at speed.
  // Tinted green-cyan so shadows land on the cool side of the split.
  const fill = new THREE.DirectionalLight(0x8fb8b0, 0.55)
  fill.position.set(30, 18, -40)
  scene.add(fill)

  // Bounce from the cloud deck below. Undersides of floating islands are lit
  // in the reference, never black — this is the light that does that.
  const bounce = new THREE.DirectionalLight(0xffe0b4, 0.35)
  bounce.position.set(0, -40, 0)
  scene.add(bounce)

  // --- drifting motes ----------------------------------------------------
  const COUNT = 900
  const pos = new Float32Array(COUNT * 3)
  const seed = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = -20 + Math.random() * 280
    pos[i * 3 + 1] = -6 + Math.random() * 34
    pos[i * 3 + 2] = -60 + Math.random() * 120
    seed[i] = Math.random() * Math.PI * 2
  }
  const moteGeo = new THREE.BufferGeometry()
  moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
  const moteMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aSeed;
      uniform float uTime;
      varying float vFade;
      void main() {
        vec3 p = position;
        p.y += sin(uTime * 0.28 + aSeed) * 1.5;
        p.x += cos(uTime * 0.19 + aSeed * 1.7) * 1.1;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vFade = 0.5 + 0.5 * sin(uTime * 0.7 + aSeed * 3.1);
        gl_PointSize = 2.4 * (60.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vFade;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d)) * vFade * 0.42;
        gl_FragColor = vec4(1.0, 0.94, 0.80, a);
      }
    `,
  })
  const motes = new THREE.Points(moteGeo, moteMat)
  motes.frustumCulled = false
  motes.name = 'motes'
  scene.add(motes)

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // Tone mapping belongs to the composite pass (AgX), not to the renderer.
  // Leaving ACES on here would be inert but misleading — three disables it
  // when rendering into a target anyway.
  renderer.toneMapping = THREE.NoToneMapping
  scene.background = null

  return {
    sunDir,
    /** Keep the shadow frustum and sky centred on the player. */
    update(time, playerPos) {
      moteMat.uniforms.uTime.value = time
      sky.material.uniforms.uTime.value = time
      sky.position.copy(playerPos)
      sun.target.position.copy(playerPos)
      sun.position.copy(playerPos).addScaledVector(sunDir, 70)
      sun.target.updateMatrixWorld()
    },
  }
}

export { PALETTE }
