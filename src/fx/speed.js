import * as THREE from 'three'
import { TUNING } from '../player.js'
import { disposeMoteField, sharedMoteField } from './motes.js'

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
 * Three parts:
 *   1. A full-screen overlay pass (streaks, vignette, colour fringing) drawn
 *      after the world with no depth interaction.
 *   2. Real 3D wind streaks that fly past the camera, which give the effect
 *      parallax the flat overlay cannot.
 *   3. The impact layer (`motes.js`) — dust, leaf litter and brass sparks
 *      thrown by landings, slides, wall-jumps and dashes. This class owns the
 *      pool's clock because it is the effect that is ticked every frame.
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
  uniform vec2  uCenter;     // where the player is actually headed, in the
                             // same aspect-corrected space as p

  // Cheap hash — good enough for streak placement, and stable per angle.
  float hash(float n) { return fract(sin(n) * 43758.5453123); }

  void main() {
    // Work in aspect-corrected space so streaks stay radial on wide monitors.
    vec2 screen = (vUv - 0.5) * vec2(uAspect, 1.0);

    // Streaks radiate from the direction of travel, not from the middle of the
    // screen. This is the single biggest honesty win in the whole effect: look
    // sideways while flying and the wind visibly comes past you from where you
    // are going, exactly as it does out of a car window. The offset is clamped
    // hard on the CPU side so the origin can never leave the frame — an origin
    // out in the void turns every streak parallel, which reads as a wipe.
    vec2 p = screen - uCenter;
    float r = length(p) * 2.0;
    float a = atan(p.y, p.x);
    float rScreen = length(screen) * 2.0;

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
    // the edge of vision, not something you look at. Note this is measured
    // from the *screen* centre, not from the travel origin: the protected
    // region is where the player's eyes are, which does not move.
    float peripheral = smoothstep(0.62, 1.25, rScreen);
    streak *= peripheral;

    // Sustained speed and burst carry comparable weight. The original split
    // (0.30 sustained / 0.42 burst) meant the only time streaks were really
    // visible was the half-second after a dash — so holding a fast line, which
    // is the entire skill the game rewards, looked exactly like jogging. A
    // reward you cannot see is a reward the player will not fight for. The
    // sustained term now leads and the burst rides on top of it as a flare.
    float streakAmt = streak * (intensity * 0.34 + uBurst * 0.30);

    // --- speed vignette ---------------------------------------------------
    // Tightens as you accelerate — and "tightens" means the aperture actually
    // closes in, not just that the corners get darker. Darkening alone is a
    // filter; a moving inner edge is the tunnel-vision cue the eye reads as
    // speed. 0.44 is the tightest it ever gets: measured in aspect-corrected
    // radius that still leaves a clean circle roughly 40% of the frame height
    // across in the middle, which is where the landing target lives.
    float vigInner = mix(0.62, 0.44, intensity);
    float vig = smoothstep(vigInner, 1.5, rScreen) * (0.20 + intensity * 0.42 + uSlide * 0.18);

    // --- slide: grit and glare along the bottom edge ----------------------
    // A slide puts the eye 80 cm off the deck with the ground tearing past.
    // The 3D grit plume sells most of it, but a warm wash rising off the
    // bottom of the frame is what makes the deck feel *close*. Bottom edge
    // only, and gone within a couple of frames of standing up.
    float floorGlow = smoothstep(0.42, 0.0, vUv.y) * uSlide;

    // --- peripheral colour fringing --------------------------------------
    // A cheap stand-in for lateral chromatic aberration: warm the outer ring
    // on one side of the streak, cool it on the other.
    float fringe = streakAmt * 0.5;
    vec3 col = uTint * streakAmt;
    col.r += fringe * 0.35;
    col.b += fringe * 0.20;

    // The slide wash is warm sandstone, and it *adds* — the deck is bouncing
    // golden-hour light up into the lens, so it brightens the bottom of the
    // frame rather than darkening it.
    float glowAmt = floorGlow * 0.16;
    col += vec3(0.62, 0.42, 0.22) * glowAmt;

    // Composite: additive streaks over a tinted vignette, delivered through a
    // single normal-blended alpha.
    //
    // The vignette is NOT black. This world's shadows are cool and green-tinted
    // against a warm key, and a neutral black corner in a golden-hour frame
    // reads as a UI overlay dimming the game rather than as light falling off.
    // A deep teal keeps the darkened corners inside the palette.
    vec3 vigCol = vec3(0.045, 0.075, 0.075);

    float lit = streakAmt + glowAmt;
    float alpha = clamp(vig + lit, 0.0, 1.0);
    // Solve for the source colour that, blended with this alpha, lands the
    // wanted contribution: vigCol * vig for the vignette plus col for the
    // streaks. The previous line divided col by alpha *and* multiplied it by
    // lit, which is streakAmt a second time — so streaks arrived squared, at
    // roughly a third of the brightness the coefficients above claim. That is
    // half the reason this layer was invisible; the onset curve was the other.
    vec3 outCol = (vigCol * vig + col) / max(alpha, 1e-4);

    gl_FragColor = vec4(clamp(outCol, 0.0, 4.0), alpha);
  }
`

/**
 * The speed band, in metres per second.
 *
 * These four numbers decide whether the whole layer is visible at all, so they
 * are stated in absolute m/s rather than as fractions of TUNING: the thing they
 * have to agree with is the speed the *course* produces, not the speed the
 * controller theoretically allows.
 */

// Where the layer starts to exist. Below this the frame must be perfectly
// clean — a permanent vignette while strolling is what "drugged" feels like.
// Sitting just under the flat-ground sprint cap (11.0) means a level sprint
// gets a whisper and everything earned above it escalates from there, which is
// the correct reading: the effect is a readout of momentum you had to work for.
const V_FLOOR = TUNING.sprintSpeed * 0.85     //  9.35 m/s ≈ 34 km/h

// The speed the course actually sustains. Read off the capture poses in
// tools/shots.mjs: the brass crossing is flown at 13.0 m/s and the pillar
// chain at 12.1 m/s — 44 to 47 km/h — and nothing on the route holds much
// more than that without a dash or a long drop. The previous curve normalised
// over [sprint, 0.75 * maxSpeed] and so returned ~0.10 here: a tenth of an
// effect at the only speed anybody ever plays at. This is the value the layer
// has to look right at, so the curve is anchored to it.
const V_CRUISE = 13.9                         // 13.9 m/s = 50 km/h

// Genuinely exceptional: a dash (21 m/s) fired out of a dive, or the bottom of
// a long fall. There has to be headroom above cruise or the fastest moment in
// the game looks identical to a good wall-run.
const V_PEAK = 26                             // 26 m/s ≈ 94 km/h

// How much of full strength a cruise is worth. The remainder is reserved for
// the stretch up to V_PEAK, which makes the curve steep where the player lives
// and gentle above it — the opposite of what it used to be.
const CRUISE_WEIGHT = 0.62

/** Hermite ease over a value already expressed as a 0..1 band position. */
function smoothstep01(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  // Ease in and out — a linear ramp makes the onset feel like a switch.
  return t * t * (3 - 2 * t)
}

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
      uCenter: { value: new THREE.Vector2(0, 0) },
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
    // 110, not the 200 this started at. Captured at 40 m/s the dense field
    // read as a hyperspace jump: a white cage over the whole frame with the
    // landing platform somewhere behind it. Wind you can count is wind that is
    // doing its job; wind you have to see through is a wall.
    this.STREAKS = 110
    // Thin, but not a hairline. A one-pixel additive line over a soft hazy sky
    // reads as a scratch on the lens rather than as air, and no amount of
    // opacity tuning fixes it — the fix is a slightly wider, much fainter quad.
    const streakGeo = new THREE.PlaneGeometry(0.028, 1)
    streakGeo.translate(0, -0.5, 0)   // pivot at the head, so scaling trails back
    this.streakMat = new THREE.MeshBasicMaterial({
      // Warm, not white. Everything in this world is lit by a low sun, and a
      // neutral streak reads as a UI element laid over the picture.
      color: 0xffe4bc,
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
    // Seeded, not Math.random: two loads of the same page must produce the
    // same wind field, or the capture harness cannot tell an intentional
    // change from noise. (Same reason the world's geometry is deterministic.)
    this._rng = 0x2545f491
    for (let i = 0; i < this.STREAKS; i++) this._life[i] = this._rand()

    // --- the impact layer --------------------------------------------------
    // `this.scene` above is the overlay's own orthographic scene; this is the
    // world. Two things called scene in one file is a trap, hence the name.
    this.scene3d = scene
    this.motes = sharedMoteField(scene)

    // Scratch — update() runs every frame and must not allocate.
    this._m = new THREE.Matrix4()
    this._q = new THREE.Quaternion()
    this._v = new THREE.Vector3()
    this._scale = new THREE.Vector3()
    this._dir = new THREE.Vector3()
    this._smoothDir = new THREE.Vector3(1, 0, 0)
    this._up = new THREE.Vector3(0, 1, 0)
    this._sideA = new THREE.Vector3()
    this._sideB = new THREE.Vector3()
    this._invQ = new THREE.Quaternion()
    this._view = new THREE.Vector3()
    this._wallN = new THREE.Vector3(1, 0, 0)

    // Movement-state edges, sampled once per rendered frame.
    //
    // These are derived from the player's *state* rather than from
    // `player.events`, deliberately. The event list is cleared at the top of
    // every fixed simulation substep, so by the time an effect layer runs —
    // after the substep loop — it can only see whatever happened in the last
    // substep, and a landing that occurred in the first of three is simply
    // gone. State edges cannot miss.
    this._wasGrounded = false
    this._prevVelY = 0
    this._prevWallCd = 0
    this._prevGrappling = false

    this.burst = 0
    /** Impulse component of the shake. `shake` is this plus the speed rumble. */
    this._decayShake = 0
    this.shake = 0
    this.time = 0
  }

  /** Deterministic uniform [0,1). Same LCG as the mote field, own stream. */
  _rand() {
    this._rng = (Math.imul(this._rng, 1664525) + 1013904223) >>> 0
    return this._rng / 4294967296
  }

  /** Fire a one-off impulse: dash, wall-jump, hard landing. */
  impulse(amount) {
    this.burst = Math.min(1.4, this.burst + amount)
    this._decayShake = Math.min(1, this._decayShake + amount * 0.7)
  }

  setSize(width, height) {
    this.uniforms.uAspect.value = width / height
    this.motes.setSize(width, height)
  }

  update(dt, player, camera) {
    const h = Math.min(dt, 1 / 30)
    this.time += h
    this.uniforms.uTime.value = this.time

    // Two segments, not one. A single ramp from sprint to the controller's top
    // speed spends almost its entire range on speeds the course never reaches,
    // so the part of the curve the player actually occupies is the flat bit at
    // the bottom. Splitting it lets the layer reach ~0.56 of full strength at
    // the 44-47 km/h a good line sustains, while still leaving a third of the
    // range for dashes and long falls to escalate into.
    //
    // Driven by 3D speed so a long fall registers as fast — which it is.
    const v = player.speed3d
    const cruise = smoothstep01((v - V_FLOOR) / (V_CRUISE - V_FLOOR))
    const peak = smoothstep01((v - V_CRUISE) / (V_PEAK - V_CRUISE))
    const target = cruise * CRUISE_WEIGHT + peak * (1 - CRUISE_WEIGHT)

    const cur = this.uniforms.uSpeed.value
    // Rise faster than it falls: acceleration should feel immediate, and the
    // decay is what makes stopping feel like relief.
    this.uniforms.uSpeed.value += (target - cur) * (1 - Math.exp(-(target > cur ? 9 : 5) * h))

    this.burst *= Math.exp(-5.5 * h)
    this._decayShake *= Math.exp(-7 * h)
    this.uniforms.uBurst.value = Math.min(1, this.burst)
    this.uniforms.uSlide.value += ((player.sliding ? 1 : 0) - this.uniforms.uSlide.value) * (1 - Math.exp(-10 * h))

    // Shake has two sources: the impulse from an event, and a low rumble that
    // only exists at the top of the speed band. The rumble is capped very low
    // (the rig turns 1.0 into ~0.6° of rotation) because sustained shake is
    // the fastest way to make a first-person game unplayable — it is meant to
    // be felt as instability, never seen as vibration.
    this.shake = Math.max(this._decayShake, this.uniforms.uSpeed.value * 0.22)

    this._updateAimCentre(h, player, camera)
    this._updateStreaks(h, player, camera)
    this._updateImpacts(h, player, camera)
    this.motes.update(dt, camera)
  }

  /**
   * Project the direction of travel into screen space for the streak origin.
   *
   * Clamped to well inside the frame. Once the origin leaves the picture the
   * streaks stop diverging and become a parallel wipe across the view, which
   * is both wrong and unpleasant; and the offset is scaled by intensity so it
   * eases out to dead centre as the player slows rather than snapping.
   */
  _updateAimCentre(h, player, camera) {
    const target = this.uniforms.uCenter.value
    const speed = player.speed3d
    let cx = 0, cy = 0

    if (speed > TUNING.sprintSpeed * 0.6) {
      this._invQ.copy(camera.quaternion).invert()
      this._view.copy(player.velocity).divideScalar(speed).applyQuaternion(this._invQ)
      // Behind the eye there is no meaningful on-screen origin (running
      // backwards), so fall back to the centre rather than mirroring it.
      if (this._view.z < -0.15) {
        // Perspective divide by hand: proj[0][0] and proj[1][1] carry the FOV
        // and the aspect, and the shader's space is already aspect-corrected
        // in x, so x is scaled by proj[1][1] in both axes.
        const e = camera.projectionMatrix.elements
        const invZ = -1 / this._view.z
        cx = this._view.x * invZ * e[5] * 0.5
        cy = this._view.y * invZ * e[5] * 0.5
        // 0.34 of the half-height: comfortably inside the frame at any aspect.
        const len = Math.hypot(cx, cy)
        if (len > 0.34) { const s = 0.34 / len; cx *= s; cy *= s }
        const w = this.uniforms.uSpeed.value
        cx *= w; cy *= w
      }
    }

    // Smoothed for the same reason the streak direction is: a landing or a
    // dash can swing the velocity vector through ninety degrees in one frame.
    const k = 1 - Math.exp(-7 * h)
    target.x += (cx - target.x) * k
    target.y += (cy - target.y) * k
  }

  _updateStreaks(h, player, camera) {
    const speed = player.speed3d
    const vis = Math.max(this.uniforms.uSpeed.value, this.uniforms.uBurst.value * 0.8)
    // Part linear, part squared. A pure square was the right instinct against
    // hairline scratches on the sky, but combined with the old speed curve it
    // meant the wind field was at 0.2% opacity at the speed the course runs at
    // — present in the draw call and absent from the picture. The linear term
    // gives the field a floor you can actually see once past V_FLOOR; the
    // squared term still reserves most of the density for the top of the band,
    // so a dash reads as a step change rather than as more of the same.
    this.streakMat.opacity = vis * (0.10 + vis * 0.24)
    // Below this the field is a handful of near-transparent flecks that cost a
    // draw call to not be seen. Set just above what a flat-ground sprint makes.
    this.streaks.visible = vis > 0.22
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

    // A dash can reverse the direction of travel in a single frame. Easing
    // through that reversal sweeps every streak in the field through 180°,
    // which reads as the whole screen flipping over. When the direction
    // changes that hard, cut instead of sweeping: snap the frame of reference
    // and recycle every streak so the new field simply *starts*, with no
    // visible rotation at all. Cuts are invisible; arcs are not.
    if (this._dir.dot(this._smoothDir) < 0.55) {
      this._smoothDir.copy(this._dir)
      for (let i = 0; i < this.STREAKS; i++) this._life[i] = 0
    } else {
      this._smoothDir.lerp(this._dir, 1 - Math.exp(-6 * h))
    }

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
    // Short. A six-metre streak seen from four metres away subtends most of
    // the frame, so the "wind" ends up being one enormous line through the
    // middle of the picture. These are meant to be flecks that whip past.
    const length = 0.5 + vis * 2.2

    // A basis perpendicular to travel, so the spawn ring is a real ring around
    // the direction of flight. The previous version shared one sine between y
    // and z, which is a squashed ellipse that leans into the travel axis — the
    // spawn distance then varied by the radius and the "ring" partly collapsed
    // onto the view axis. Up is a safe reference: the pole case was already
    // nudged away two lines above.
    this._sideA.set(0, 1, 0).cross(this._smoothDir).normalize()
    this._sideB.copy(this._smoothDir).cross(this._sideA).normalize()

    const cam = camera.position
    for (let i = 0; i < this.STREAKS; i++) {
      this._life[i] -= h * (0.5 + speed * 0.09)
      const i3 = i * 3

      if (this._life[i] <= 0) {
        // Respawn ahead of the camera in a ring — never dead centre, or they
        // fly straight into the reticle and obscure the landing.
        const ang = this._rand() * Math.PI * 2
        // The ring radius is proportional to how far ahead the streak spawns,
        // which is the whole trick: a fixed 3 m ring placed 20 m up the road
        // subtends 8°, i.e. dead centre of the frame, which is exactly how the
        // first version ended up drawing wind straight across the landing
        // target. Scaling the radius with the distance holds every streak at a
        // constant 27°–50° off the axis of travel — always peripheral, at any
        // spawn distance.
        const ahead = 3 + this._rand() * 10
        const rad = ahead * (0.5 + this._rand() * 0.7)
        this._life[i] = 0.5 + this._rand() * 0.7
        const ca = Math.cos(ang) * rad, sa = Math.sin(ang) * rad
        this._pos[i3] = cam.x + this._smoothDir.x * ahead + this._sideA.x * ca + this._sideB.x * sa
        this._pos[i3 + 1] = cam.y + this._smoothDir.y * ahead + this._sideA.y * ca + this._sideB.y * sa
        this._pos[i3 + 2] = cam.z + this._smoothDir.z * ahead + this._sideA.z * ca + this._sideB.z * sa
      }

      this._v.set(this._pos[i3], this._pos[i3 + 1], this._pos[i3 + 2])
      this._scale.set(1, length * (0.4 + this._life[i]), 1)
      this._m.compose(this._v, this._q, this._scale)
      this.streaks.setMatrixAt(i, this._m)
    }
    this.streaks.instanceMatrix.needsUpdate = true
  }

  /**
   * Drive the impact layer from movement-state edges.
   *
   * Every threshold here is deliberately above the noise floor. A capture
   * harness (and a respawn) teleports the player, which re-grounds them on the
   * following step; if a landing puff fired on the bare grounded edge, every
   * screenshot of a player standing on a deck would have a dust cloud in it.
   * Requiring a real fall speed means only a real landing throws dust.
   */
  _updateImpacts(h, player, camera) {
    const motes = this.motes

    // --- landing ---------------------------------------------------------
    if (player.grounded && !this._wasGrounded) {
      // The controller has already zeroed the fall by the time we look, so the
      // impact has to come from the speed we saw on the previous frame. 3 m/s
      // is roughly a step off a kerb — below that a landing raises nothing.
      const fall = -this._prevVelY
      if (fall > 3.0) {
        motes.land(
          player.position,
          Math.min(1, (fall - 3.0) / 14),
          player.velocity.x, player.velocity.z,
        )
      }
    }
    this._wasGrounded = player.grounded
    this._prevVelY = player.velocity.y

    // --- sliding ---------------------------------------------------------
    if (player.sliding && player.grounded && player.speed > 3.0) {
      motes.slide(h, player.position, player.velocity, player.speed)
    }

    // --- wall-jump -------------------------------------------------------
    // The wall regrab cooldown is only ever counted *down* by the controller,
    // so the single frame on which it goes up is exactly the frame a wall was
    // kicked off. No event plumbing required, and it cannot be missed.
    if (player.wallCooldown > this._prevWallCd + 1e-4) {
      // Sparks belong where the boot is: on the wall, at about knee height,
      // thrown back along the surface normal we were attached to.
      const n = this._wallN
      motes.sparks(
        player.position.x - n.x * (TUNING.radius + 0.05),
        // Chest height, not boot height. Sparks struck at the feet sit ~1.5 m
        // below the eye and about 60° down — the pool instrumentation put zero
        // of forty-four inside the frustum three frames after the kick. Raised
        // to just under the eye line they clip the edge of the view as the
        // player rotates away, which is where a wall-jump is felt anyway.
        player.position.y + 1.15,
        player.position.z - n.z * (TUNING.radius + 0.05),
        n.x, 0, n.z,
        0.85,
        player.velocity.x, player.velocity.y, player.velocity.z,
      )
    }
    this._prevWallCd = player.wallCooldown

    // Remember the last wall we were actually attached to. A wall-jump taken
    // from a probe (never formally attached) leaves `wallNormal` stale, and a
    // stale normal from the wall two metres back is still a better guess than
    // spraying sparks in an arbitrary direction.
    if (player.wallRunning && player.wallNormal.lengthSq() > 0.5) {
      this._wallN.copy(player.wallNormal)
    }

    // --- lateral wall-run -------------------------------------------------
    // The climb below already left a mark on the air; a lateral run left none,
    // so running ON a wall and falling PAST one produced the same picture.
    // Contact point is the surface itself — back along the normal by the
    // capsule radius — at chest height, for the same reason the wall-jump
    // sparks are raised: struck at the boots they sit 60° below the eye and
    // never enter the frame.
    if (player.wallRunning && player.speed > 2.5) {
      const n = player.wallNormal
      const vx = player.velocity.x, vz = player.velocity.z
      const vl = Math.hypot(vx, vz)
      if (vl > 0.001 && n.lengthSq() > 0.5) {
        const r = TUNING.radius + 0.05
        motes.wallrun(
          h,
          player.position.x - n.x * r,
          player.position.y + 1.05,
          player.position.z - n.z * r,
          n.x, 0, n.z,
          vx / vl, vz / vl,
          player.speed,
        )
      }
    }

    // --- vertical wall-run ------------------------------------------------
    if (player.climbTimer > 0) {
      // Facing direction, from the camera: a climb is always straight at the
      // wall you are looking at, and the camera basis is already to hand.
      this._view.set(0, 0, -1).applyQuaternion(camera.quaternion)
      const fx = this._view.x, fz = this._view.z
      const fl = Math.hypot(fx, fz)
      if (fl > 0.001) {
        const nx = fx / fl, nz = fz / fl
        motes.climb(
          h,
          player.position.x + nx * (TUNING.radius + 0.1),
          player.position.y + 0.75,
          player.position.z + nz * (TUNING.radius + 0.1),
          -nx, 0, -nz,           // sparks come off the wall, back toward us
        )
      }
    }

    // --- dash -------------------------------------------------------------
    if (player.dashTimer > 0) {
      const s = player.speed3d
      if (s > 0.001) {
        motes.dash(h, camera.position, player.velocity.x / s, player.velocity.y / s, player.velocity.z / s)
      }
    }

    // --- grapple latch / release -----------------------------------------
    if (player.grappling !== this._prevGrappling) {
      const a = player.grappleAnchor
      // Latching sparks at the anchor; letting go puffs at the player, which
      // is where the energy actually goes.
      if (player.grappling) motes.puff(a.x, a.y, a.z, 1.2)
      else motes.puff(player.position.x, player.position.y + 1.0, player.position.z, 0.6)
      this._prevGrappling = player.grappling
    }
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
    // The pool is shared, and this class is the one that drives it, so tearing
    // the speed layer down tears the pool down with it.
    disposeMoteField(this.scene3d)
  }
}
