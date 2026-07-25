import * as THREE from 'three'
import { TUNING } from '../player.js'

/**
 * The speed layer.
 *
 * Racing games sell velocity almost entirely through the *frame*, not through
 * the car: the edges of the screen streak and darken, the world narrows, the
 * image tears slightly at the corners, and the whole thing settles the instant
 * you lift off. None of that is simulation — it is a lie told convincingly and
 * consistently, and it works because the player's peripheral vision is where
 * real motion perception lives.
 *
 * So everything here is peripheral by construction: the centre of the screen
 * stays clean so the player can still read the route they are about to jump
 * onto, and all the noise lives out past ~40% of the radius.
 *
 * Two parts:
 *   1. A full-screen overlay pass (streaks, vignette, colour fringing) drawn
 *      after the world with no depth interaction.
 *   2. Real 3D wind streaks that fly past the camera, which give the effect
 *      parallax the flat overlay cannot.
 */

const OVERLAY_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const OVERLAY_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;

  uniform float uTime;
  uniform float uSpeed;      // 0..1, normalised over the useful speed band
  uniform float uBurst;      // 0..1, dash / wall-jump impulse
  uniform float uSlide;      // 0..1, sliding
  uniform float uAspect;
  uniform vec3  uTint;

  // Cheap hash — good enough for streak placement, and stable per angle.
  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    // Work in aspect-corrected space so streaks stay radial on wide monitors.
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(p) * 2.0;
    float a = atan(p.y, p.x);

    float intensity = max(uSpeed, uBurst);

    // --- radial speed streaks -------------------------------------------
    // Streaks are keyed off the *angle* so they sit still laterally and only
    // move outward, which is what reads as forward motion rather than spin.
    float lanes = 46.0;
    float lane = floor((a / 6.2831853 + 0.5) * lanes);
    float seed = hash(lane * 12.9898);

    // Each lane races outward at its own rate, wrapping in [0,1).
    float travel = fract(seed + uTime * (1.4 + seed * 2.2) * (0.35 + intensity));
    // Where along the radius this lane's streak currently sits.
    float head = mix(0.35, 1.45, travel);
    float len = 0.10 + seed * 0.22 + uBurst * 0.25;

    float streak = smoothstep(head, head - len, r) * smoothstep(head - len - 0.12, head - len, r);
    // Sub-lane thickness: only part of each angular slot is lit.
    float across = fract((a / 6.2831853 + 0.5) * lanes);
    streak *= smoothstep(0.5, 0.0, abs(across - 0.5) * 2.0);

    // Keep the centre of the screen clear — the player is reading the route
    // there, and streaks over a landing target actively hurt. This threshold
    // is deliberately far out: the effect should be something you notice at
    // the edge of vision, not something you look at.
    float peripheral = smoothstep(0.62, 1.25, r);
    streak *= peripheral;

    float streakAmt = streak * (intensity * 0.30 + uBurst * 0.42);

    // --- speed vignette ---------------------------------------------------
    // Tightens as you accelerate. This alone does a surprising amount of the
    // work; the streaks read as detail on top of it.
    float vig = smoothstep(0.55, 1.5, r) * (0.22 + intensity * 0.5 + uSlide * 0.18);

    // --- peripheral colour fringing --------------------------------------
    // A cheap stand-in for lateral chromatic aberration: warm the outer ring
    // on one side of the streak, cool it on the other.
    float fringe = streakAmt * 0.5;
    vec3 col = uTint * streakAmt;
    col.r += fringe * 0.35;
    col.b += fringe * 0.20;

    // Composite: additive streaks, multiplicative vignette.
    // Alpha carries the vignette so it darkens whatever is underneath.
    float alpha = clamp(vig + streakAmt, 0.0, 1.0);
    vec3 outCol = mix(vec3(0.0), col, clamp(streakAmt / max(alpha, 1e-4), 0.0, 1.0));

    gl_FragColor = vec4(outCol, alpha);
  }
`

export class SpeedFX {
  constructor(scene) {
    // --- overlay ----------------------------------------------------------
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // A full-screen triangle: one draw, no seam down the diagonal, and it
    // rasterises fewer helper pixels than two triangles.
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2))

    this.uniforms = {
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uBurst: { value: 0 },
      uSlide: { value: 0 },
      uAspect: { value: 1 },
      uTint: { value: new THREE.Color(0xfff0d4) },
    }

    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: OVERLAY_VERT,
      fragmentShader: OVERLAY_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    }))
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)

    // --- 3D wind streaks --------------------------------------------------
    // Flat overlays have no parallax, so at speed they read as a filter over
    // the game rather than as air moving past you. These fix that.
    this.STREAKS = 200
    // Thin. A wind streak that reads as a visible object is a distraction
    // sitting between the player and the ledge they are trying to land on.
    const streakGeo = new THREE.PlaneGeometry(0.012, 1)
    streakGeo.translate(0, -0.5, 0)   // pivot at the head, so scaling trails back
    this.streakMat = new THREE.MeshBasicMaterial({
      color: 0xfff4de,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
    this.streaks = new THREE.InstancedMesh(streakGeo, this.streakMat, this.STREAKS)
    this.streaks.frustumCulled = false
    this.streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.streaks.name = 'wind-streaks'
    scene.add(this.streaks)

    this._pos = new Float32Array(this.STREAKS * 3)
    this._life = new Float32Array(this.STREAKS)
    for (let i = 0; i < this.STREAKS; i++) this._life[i] = Math.random()

    // Scratch — update() runs every frame and must not allocate.
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._v = new THREE.Vector3()
    this._scale = new THREE.Vector3()
    this._dir = new THREE.Vector3()
    this._smoothDir = new THREE.Vector3(1, 0, 0)
    this._up = new THREE.Vector3(0, 1, 0)

    this.burst = 0
    this.shake = 0
    this.time = 0
  }

  /** Fire a one-off impulse: dash, wall-jump, hard landing. */
  impulse(amount) {
    this.burst = Math.min(1.4, this.burst + amount)
    this.shake = Math.min(1, this.shake + amount * 0.7)
  }

  setSize(width, height) {
    this.uniforms.uAspect.value = width / height
  }

  update(dt, player, camera) {
    const h = Math.min(dt, 1 / 30)
    this.time += h
    this.uniforms.uTime.value = this.time

    // Normalised over the band where speed actually feels fast: below sprint
    // there should be no effect at all, or walking around feels drugged.
    // Driven by 3D speed so a long fall registers as fast — which it is.
    const band = (player.speed3d - TUNING.sprintSpeed * 0.9) /
                 (TUNING.maxSpeed * 0.75 - TUNING.sprintSpeed * 0.9)
    const t = Math.min(1, Math.max(0, band))
    // Ease in — a linear ramp makes the onset feel like a switch.
    const target = t * t * (3 - 2 * t)

    const cur = this.uniforms.uSpeed.value
    // Rise faster than it falls: acceleration should feel immediate, and the
    // decay is what makes stopping feel like relief.
    this.uniforms.uSpeed.value += (target - cur) * (1 - Math.exp(-(target > cur ? 9 : 5) * h))

    this.burst *= Math.exp(-5.5 * h)
    this.shake *= Math.exp(-7 * h)
    this.uniforms.uBurst.value = Math.min(1, this.burst)
    this.uniforms.uSlide.value += ((player.sliding ? 1 : 0) - this.uniforms.uSlide.value) * (1 - Math.exp(-10 * h))

    this._updateStreaks(h, player, camera)
  }

  _updateStreaks(h, player, camera) {
    const speed = player.speed3d
    const vis = Math.max(this.uniforms.uSpeed.value, this.uniforms.uBurst.value * 0.8)
    this.streakMat.opacity = vis * 0.22
    this.streaks.visible = vis > 0.02
    if (!this.streaks.visible) return

    // Streaks are born in a cylinder around the camera and swept backwards
    // along the player's velocity, so they lengthen exactly when the player
    // is moving fastest and stay put when they are not.
    //
    // The vertical term is heavily damped and the whole direction is smoothed
    // over time. Landing flips `velocity.y` from strongly negative to zero in
    // a single frame, and orienting straight off raw velocity makes every
    // streak in the field swing through ninety degrees on that frame — which
    // is the "goes weird when you land" tumble. Smoothing costs nothing and
    // the direction it lags toward is the one the player is actually reading.
    this._dir.set(player.velocity.x, player.velocity.y * 0.22, player.velocity.z)
    const vlen = this._dir.length()
    if (vlen < 0.001) return
    this._dir.divideScalar(vlen)

    this._smoothDir.lerp(this._dir, 1 - Math.exp(-6 * h))
    const sl = this._smoothDir.length()
    if (sl < 0.001) return
    this._smoothDir.divideScalar(sl)

    // setFromUnitVectors is degenerate when the direction is (anti)parallel to
    // the reference axis; nudge off the pole rather than emitting NaNs.
    if (Math.abs(this._smoothDir.y) > 0.995) {
      this._smoothDir.x += 0.05
      this._smoothDir.normalize()
    }

    // Orient the quad so its local +Y runs along the direction of travel.
    this._q.setFromUnitVectors(this._up, this._smoothDir)
    const length = 1.2 + vis * 5.5

    const cam = camera.position
    for (let i = 0; i < this.STREAKS; i++) {
      this._life[i] -= h * (0.5 + speed * 0.09)
      const i3 = i * 3

      if (this._life[i] <= 0) {
        // Respawn ahead of the camera in a ring — never dead centre, or they
        // fly straight into the reticle and obscure the landing.
        const ang = Math.random() * Math.PI * 2
        // Wider inner radius: streaks belong in peripheral vision, never
        // across the middle of the screen where the route is being read.
        const rad = 3.2 + Math.random() * 7.0
        this._life[i] = 0.5 + Math.random() * 0.7
        this._pos[i3] = cam.x + Math.cos(ang) * rad + this._smoothDir.x * (7 + Math.random() * 16)
        this._pos[i3 + 1] = cam.y + Math.sin(ang) * rad * 0.7 + this._smoothDir.y * (7 + Math.random() * 16)
        this._pos[i3 + 2] = cam.z + Math.sin(ang) * rad + this._smoothDir.z * (7 + Math.random() * 16)
      }

      this._v.set(this._pos[i3], this._pos[i3 + 1], this._pos[i3 + 2])
      this._scale.set(1, length * (0.4 + this._life[i]), 1)
      this._m.compose(this._v, this._q, this._scale)
      this.streaks.setMatrixAt(i, this._m)
    }
    this.streaks.instanceMatrix.needsUpdate = true
  }

  /** Draw the overlay. Call after the world has been rendered. */
  render(renderer) {
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.scene, this.camera)
    renderer.autoClear = prevAutoClear
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.streaks.geometry.dispose()
    this.streakMat.dispose()
  }
}
