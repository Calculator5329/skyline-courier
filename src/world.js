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

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    // Two-stage vertical gradient: a tight warm band at the horizon under a
    // wide cool wash, which is what stops it reading as a flat blue wall.
    vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
    sky = mix(sky, uGround, smoothstep(0.0, -0.32, h));

    float sun = max(dot(d, normalize(uSunDir)), 0.0);
    sky += uSunColor * pow(sun, 220.0) * 1.6;        // the disc
    sky += uSunColor * pow(sun, 7.0) * 0.16;         // the bloom around it
    sky += uSunColor * pow(sun, 2.0) * 0.05 * smoothstep(0.4, 0.0, abs(h));

    gl_FragColor = vec4(sky, 1.0);
  }
`

export function buildWorld(scene, renderer) {
  const sunDir = new THREE.Vector3(-0.42, 0.46, 0.78).normalize()
  const horizon = new THREE.Color(0xf0d9bc)

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
        uZenith: { value: new THREE.Color(0x5f9dc4) },
        uHorizon: { value: horizon },
        uGround: { value: new THREE.Color(0x6c7a80) },
        uSunDir: { value: sunDir },
        uSunColor: { value: new THREE.Color(0xfff0d0) },
      },
    }),
  )
  sky.name = 'sky'
  scene.add(sky)

  // Fog tuned to the horizon band so distant towers dissolve into it rather
  // than ending abruptly against a different colour.
  scene.fog = new THREE.FogExp2(horizon.getHex(), 0.0034)

  // --- light ------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xbdd9ea, 0x6b5f4c, 1.05)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff2da, 2.5)
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

  // A dim fill from the opposite side keeps shadowed faces readable, which
  // matters more than realism when the player is reading a route at speed.
  const fill = new THREE.DirectionalLight(0xa9c4d8, 0.5)
  fill.position.set(30, 18, -40)
  scene.add(fill)

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
      sky.position.copy(playerPos)
      sun.target.position.copy(playerPos)
      sun.position.copy(playerPos).addScaledVector(sunDir, 70)
      sun.target.updateMatrixWorld()
    },
  }
}

export { PALETTE }
