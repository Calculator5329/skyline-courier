import * as THREE from 'three'

/**
 * The impact layer: dust, leaf litter, and brass sparks.
 *
 * Everything the player does to the world should leave a mark on the air for
 * half a second. A landing that only dips the camera reads as a UI event; a
 * landing that punches a ring of dust out from under your boots reads as a
 * body hitting stone. Same for a slide (a rooster tail of grit behind you), a
 * wall-jump (brass struck hard enough to spark), and a dash (a wake of lit
 * motes sweeping past the edges of the frame).
 *
 * ## Why one pool and one draw call
 *
 * Every kind above is the same thing: a point, launched with a velocity, under
 * gravity and drag, that fades and dies. So there is exactly one buffer, one
 * material and one draw call for the lot of them, and the *only* per-particle
 * difference is the numbers written at spawn.
 *
 * ## Why the simulation lives on the GPU
 *
 * A particle's whole trajectory is a closed-form function of its age:
 *
 *     p(t) = p0 + v0 * (1 - e^(-k t)) / k  +  ½ g t²
 *
 * (the first term is the exact solution of dv/dt = -k·v, the second is gravity
 * treated as undamped — an approximation that is invisible over a 0.9 s life
 * and saves a second exponential). Because of that the CPU never touches a
 * live particle: it writes fourteen floats at spawn and then never looks at it
 * again. Per-frame cost is one uniform write. That is the difference between
 * a particle budget and a particle *system*.
 *
 * The buffer is only re-uploaded on frames where something actually spawned.
 * A whole-buffer upload is ~40 KB, which is nothing next to the garbage that
 * three's per-attribute update ranges allocate every frame.
 *
 * ## Determinism
 *
 * Spawn jitter comes from a local LCG, not Math.random, so the same run
 * produces the same picture on every reload — which is what makes the headless
 * capture harness able to tell "I changed this" from "it moved on its own".
 */

/**
 * Particle budget. The worst realistic case is a hard landing (≈40) on top of
 * a slide already running (≈40 alive) plus a wall-jump spark burst (≈35) plus
 * a dash wake (≈30): around 150. 640 leaves room for a chaotic chain without
 * the ring buffer ever eating a particle that is still visible.
 */
const CAPACITY = 640

const VERT = /* glsl */`
  attribute vec3 aVel;
  attribute vec4 aParams;   // x birth, y life, z size, w gravity
  attribute vec4 aColor;    // rgb linear HDR colour, w drag coefficient
  attribute vec2 aSeed;     // x random seed, y end-of-life size multiplier

  uniform float uTime;
  uniform float uPixelScale;   // viewport height * proj[1][1] * 0.5

  varying vec3 vColor;
  varying float vAlpha;
  varying float vSoft;

  void main() {
    float age = uTime - aParams.x;
    float u = age / aParams.y;

    if (u < 0.0 || u > 1.0) {
      // Dead particles are collapsed to zero size behind the near plane. The
      // rasteriser discards them for free, which is cheaper than compacting
      // the buffer on the CPU and keeps every index stable for the ring.
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      vColor = vec3(0.0);
      vAlpha = 0.0;
      vSoft = 0.0;
      return;
    }

    float k = max(aColor.w, 0.001);
    vec3 p = position + aVel * ((1.0 - exp(-k * age)) / k);
    p.y += 0.5 * aParams.w * age * age;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);

    // Fast attack, quadratic release: a puff appears on the frame of impact
    // and then leaves without a hard edge.
    float fade = smoothstep(0.0, 0.05, u) * (1.0 - u) * (1.0 - u);
    // Embers do not burn steadily. Cheap flicker, keyed off the seed so no two
    // sparks in a burst pulse together.
    fade *= 0.82 + 0.18 * sin(uTime * 53.0 + aSeed.x * 6.2831853);

    float size = aParams.z * mix(1.0, aSeed.y, u);
    // Clamped: a particle spawned 20 cm from the eye would otherwise cover the
    // frame in one enormous sprite and cost more fill than the whole world.
    gl_PointSize = clamp(size * uPixelScale / max(-mv.z, 0.05), 1.0, 110.0);

    vColor = aColor.rgb;
    vAlpha = fade;
    // Sprite profile, inferred from the particle's own size rather than an
    // extra attribute: everything big in this system is dust or leaf litter
    // (broad, translucent, many overlapping) and everything small is an ember
    // (a tight hot core). One buffer, two looks, no extra bandwidth.
    vSoft = clamp(aParams.z * 9.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSoft;

  void main() {
    // Soft round sprite from the point coord — no texture, and the falloff is
    // on squared distance so it costs one dot product.
    vec2 d = gl_PointCoord - 0.5;
    float s = smoothstep(0.25, 0.0, dot(d, d));
    // Two profiles. An ember is a tight core with a faint skirt (cubed); dust
    // is a broad, weak wash that only becomes a cloud where several overlap
    // (squared and scaled down). The first version used one middling profile
    // for both and the result read as lens dirt: hard-edged bokeh balls with a
    // flat middle, at every size.
    float shape = mix(s * s * s, s * s * 0.42, vSoft);
    // Additive: dst += rgb * a. Nothing to sort, nothing to depth-write, and
    // warm motes over a golden-hour sky is exactly what additive is good at.
    gl_FragColor = vec4(vColor, vAlpha * shape);
  }
`

export class MoteField {
  constructor(scene) {
    this._pos = new Float32Array(CAPACITY * 3)
    this._vel = new Float32Array(CAPACITY * 3)
    this._params = new Float32Array(CAPACITY * 4)
    this._color = new Float32Array(CAPACITY * 4)
    this._seed = new Float32Array(CAPACITY * 2)

    // Life 0 with birth 0 means age 0 / life 0 = NaN on the very first frame,
    // and a NaN comparison is false either way, so the branch above would let
    // an uninitialised particle through. A negative birth far in the past
    // retires every slot before it is ever used.
    for (let i = 0; i < CAPACITY; i++) {
      this._params[i * 4] = -1000
      this._params[i * 4 + 1] = 1
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', dynamic(this._pos, 3))
    geo.setAttribute('aVel', dynamic(this._vel, 3))
    geo.setAttribute('aParams', dynamic(this._params, 4))
    geo.setAttribute('aColor', dynamic(this._color, 4))
    geo.setAttribute('aSeed', dynamic(this._seed, 2))
    // The pool never moves and is drawn from the camera's own position, so a
    // bounding sphere is meaningless here — and a wrong one pops the whole
    // effect out of view at exactly the moment it matters.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    this.geometry = geo

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPixelScale: { value: 500 },
      },
      transparent: true,
      depthWrite: false,
      // depthTest stays ON: dust behind a wall must be behind the wall, or the
      // effect reads as an overlay rather than as something in the world.
      depthTest: true,
      blending: THREE.AdditiveBlending,
    })

    this.points = new THREE.Points(geo, this.material)
    this.points.frustumCulled = false
    this.points.name = 'fx-motes'
    this.points.renderOrder = 5
    scene.add(this.points)

    this.time = 0
    this._next = 0
    this._dirty = false
    this._rng = 0x9e3779b9        // any odd constant; the sequence is what matters
    this._slideAcc = 0
    this._dashAcc = 0
    this._climbAcc = 0
    this._wallAcc = 0
    this._height = 900

    // Scratch. Nothing in here allocates once construction is done.
    this._a = new THREE.Vector3()
    this._b = new THREE.Vector3()
    this._c = new THREE.Vector3()
  }

  /** Deterministic uniform [0,1). A 32-bit LCG is plenty for spawn jitter. */
  _rand() {
    this._rng = (Math.imul(this._rng, 1664525) + 1013904223) >>> 0
    return this._rng / 4294967296
  }

  /** Deterministic uniform [-1,1). */
  _rand2() {
    return this._rand() * 2 - 1
  }

  /**
   * Write one particle. Fourteen positional arguments is not elegant, but the
   * alternative is an options object per spawn — i.e. garbage, forty times a
   * second, in the exact code path that exists to be cheap.
   */
  _emit(x, y, z, vx, vy, vz, life, size, grow, gravity, drag, r, g, b) {
    const i = this._next
    this._next = (i + 1) % CAPACITY

    const i2 = i * 2, i3 = i * 3, i4 = i * 4
    this._pos[i3] = x; this._pos[i3 + 1] = y; this._pos[i3 + 2] = z
    this._vel[i3] = vx; this._vel[i3 + 1] = vy; this._vel[i3 + 2] = vz
    this._params[i4] = this.time
    this._params[i4 + 1] = life
    this._params[i4 + 2] = size
    this._params[i4 + 3] = gravity
    this._color[i4] = r; this._color[i4 + 1] = g; this._color[i4 + 2] = b
    this._color[i4 + 3] = drag
    this._seed[i2] = this._rand()
    this._seed[i2 + 1] = grow
    this._dirty = true
  }

  // ------------------------------------------------------------- emitters

  /**
   * Boots hitting stone.
   *
   * A flat ring pushed outward from the contact point, not a fountain: dust
   * kicked up by a landing goes sideways along the ground first and only then
   * drifts up. `impact` is the player's own 0..1 landing impact, so a hop
   * raises a wisp and a four-storey drop raises a cloud.
   */
  land(pos, impact, vx, vz) {
    const count = 14 + Math.round(impact * 26)
    // Dust does not stay where the boots hit: a courier arriving at 11 m/s
    // drags the whole plume forward with them. Carrying a share of the
    // horizontal velocity is both what actually happens and the only way the
    // plume ever enters the frame — a puff left at the feet is 70° below the
    // eye line, i.e. under the bottom edge of the screen, and the effect might
    // as well not exist. It still falls behind the player, which is right:
    // you run out of your own dust cloud.
    // Measured, not guessed. With the pool instrumented and projected against
    // the real camera, a plume left at the feet put 1 particle of 18 inside
    // the frustum five frames after touchdown, and none by fourteen: the eye
    // is 1.53 m up and the player clears any fixed point in a seventh of a
    // second, so anything that does not keep up is instantly behind and below.
    // Carrying 70% of the horizontal velocity and throwing the cloud a stride
    // and a half forward is what puts it in the lower third of the frame,
    // where it belongs — and it still falls behind within half a second.
    const carry = 0.7
    const sp = Math.hypot(vx, vz)
    const fx = sp > 0.001 ? vx / sp : 0
    const fz = sp > 0.001 ? vz / sp : 0
    // Scaled by speed: a drop onto the spot throws dust straight up around
    // your boots, and pretending otherwise would look like a bug.
    const throwAhead = Math.min(1.5, sp * 0.13)
    for (let i = 0; i < count; i++) {
      const ang = this._rand() * Math.PI * 2
      // Wide footprint: the motes off to the sides are the ones that sweep
      // past the edges of the view as the player runs on through the cloud.
      const rad = 0.10 + this._rand() * 0.85
      // Fast and far, on purpose. The eye sits 1.53 m above the feet, so dust
      // that only travels the 1 m the first version managed stays at about 55°
      // below the horizon — i.e. under the bottom edge of the frame, invisible
      // in the only view the game ever has. It has to clear 2–3 m to enter
      // peripheral vision at all, which is the whole point of the effect.
      const out = 3.4 + this._rand() * 3.6 + impact * 4.5
      // Every fourth mote is leaf litter rather than grit. The decks in this
      // world are capped with moss, so what a landing actually throws up is
      // half dust and half torn green — and the cool green against the warm
      // dust is the same warm/cool split the art direction is built on.
      const leaf = (i & 3) === 3
      this._emit(
        // Spawned a stride ahead of the feet and a little off the deck, for
        // the same reason: that is where the cloud is by the time the eye
        // could possibly register it.
        pos.x + Math.cos(ang) * rad + fx * throwAhead,
        pos.y + 0.06 + this._rand() * 0.16,
        pos.z + Math.sin(ang) * rad + fz * throwAhead,
        Math.cos(ang) * out + vx * carry,
        // Strong lift. Dust that only creeps outward stays under the frame;
        // dust that climbs 60–80 cm in the first fifth of a second sweeps up
        // through the bottom of the view exactly as the camera dips into it.
        2.2 + this._rand() * 2.4 + impact * 2.2,
        Math.sin(ang) * out + vz * carry,
        leaf ? 0.9 + this._rand() * 0.6 : 0.55 + this._rand() * 0.5,
        leaf ? 0.055 + this._rand() * 0.045 : 0.16 + this._rand() * 0.20,
        leaf ? 0.9 : 3.0,                    // dust billows, leaves keep their size
        leaf ? -3.4 : -1.4,                  // leaves fall, dust hangs
        leaf ? 2.0 : 1.3,                    // low drag: dust has to travel
        leaf ? 0.15 : 0.165, leaf ? 0.25 : 0.118, leaf ? 0.07 : 0.074,
      )
    }
  }

  /**
   * The slide rooster tail.
   *
   * Emitted *behind* the player at deck height, so in first person you catch
   * it at the bottom edge of the frame and see the whole plume when you look
   * back — never across the middle of the screen, which is where the player is
   * reading the exit of the underpass.
   */
  slide(dt, pos, vel, speed) {
    // Rate scales with speed: a fast slide should visibly throw more grit than
    // a crawl, and tying it to speed means the effect confirms the momentum
    // the slide is actually carrying.
    this._slideAcc += dt * (24 + speed * 4.0)
    let n = Math.floor(this._slideAcc)
    if (n <= 0) return
    if (n > 8) n = 8              // never let a frame hitch dump the whole pool
    this._slideAcc -= n

    const inv = speed > 0.001 ? 1 / speed : 0
    const dx = vel.x * inv, dz = vel.z * inv
    for (let i = 0; i < n; i++) {
      // Wide enough to read as a plume rather than a string of beads. Emitting
      // many small motes over a broad footprint is what separates grit from
      // the row of soft blobs the first pass produced.
      const side = this._rand2() * 0.75
      this._emit(
        pos.x - dx * (0.3 + this._rand() * 0.5) - dz * side,
        pos.y + 0.05 + this._rand() * 0.20,
        pos.z - dz * (0.3 + this._rand() * 0.5) + dx * side,
        // Thrown backwards along the track at a fraction of the slide speed,
        // with a lazy lift. Grit does not keep up with the player who kicked it.
        -dx * speed * 0.22 + this._rand2() * 0.7,
        0.35 + this._rand() * 0.8,
        -dz * speed * 0.22 + this._rand2() * 0.7,
        0.55 + this._rand() * 0.45,
        0.13 + this._rand() * 0.16,
        3.0,
        -1.6,
        2.8,
        // Dim. These are additive over a sunlit deck that is already near
        // white; anything brighter blows straight through to a flat disc.
        0.16, 0.115, 0.070,
      )
    }
  }

  /**
   * Struck brass.
   *
   * Wall-jumps and vertical wall-runs in this world are boot against machined
   * brass, and the reference art is full of it. Sparks are emitted hot — well
   * above 1.0 in linear light — specifically so the bloom pyramid picks them
   * up and they bloom like embers instead of sitting there as orange dots.
   */
  sparks(x, y, z, nx, ny, nz, amount, vx, vy, vz) {
    const count = 16 + Math.round(amount * 22)
    // Sparks are struck by a boot travelling at 17 m/s, so they leave the wall
    // travelling too — they do not politely hang where they were born. This is
    // not a flourish: measured in view space, a stationary burst sat 0.3–0.6 m
    // BEHIND the eye two frames after the kick, because the player outruns it
    // instantly. Carrying most of the player's velocity, and being thrown a
    // few frames up the track, is what puts them in front of the camera long
    // enough to be seen streaming past.
    const carry = 0.72
    const lead = 0.07
    for (let i = 0; i < count; i++) {
      // A cone about the surface normal, widened by a full random component:
      // real sparks scatter, and a tidy cone reads as a shader effect.
      // Tight, not a starburst. A wide scatter spreads the burst so thin it
      // reads as the world's ambient fireflies; a narrow one stays a single
      // legible event streaming past the edge of the view.
      const sp = 2.2 + this._rand() * 5.0 * amount
      const jx = this._rand2(), jy = this._rand2(), jz = this._rand2()
      this._emit(
        // Spread up the wall rather than sitting in a knot at one point: a
        // wall-jump is a whole boot dragging, and the burst has to be tall
        // enough to catch the corner of the frame as the player kicks away.
        x + jx * 0.22 + vx * lead, y + jy * 0.45 + vy * lead, z + jz * 0.22 + vz * lead,
        (nx * 0.9 + jx * 0.85) * sp + vx * carry,
        (ny * 0.5 + jy * 0.85 + 0.75) * sp + vy * carry,
        (nz * 0.9 + jz * 0.85) * sp + vz * carry,
        // Long enough to still be burning a fifth of a second later, when the
        // player has kicked far enough away to actually see them.
        0.34 + this._rand() * 0.36,
        0.022 + this._rand() * 0.030,
        0.45,                       // sparks shrink as they cool
        -20.0,                      // and fall hard: they have no lift at all
        1.1,
        3.4, 1.75, 0.45,            // hot brass, deliberately over 1.0
      )
    }
  }

  /**
   * The dash wake.
   *
   * Spawned in a ring *ahead* of the eye so the motes sweep past the edges of
   * the frame during the burst rather than hanging in the middle of it. The
   * inner radius is the whole trick: nothing is ever emitted near the view
   * axis, so the route stays readable through the fastest movement in the game.
   */
  dash(dt, camPos, dirX, dirY, dirZ) {
    this._dashAcc += dt * 170
    let n = Math.floor(this._dashAcc)
    if (n <= 0) return
    if (n > 8) n = 8
    this._dashAcc -= n

    // Any vector not parallel to the travel direction gives us a basis; world
    // up fails only when dashing straight up, which the controller cannot do.
    this._a.set(dirX, dirY, dirZ)
    this._b.set(0, 1, 0).cross(this._a)
    if (this._b.lengthSq() < 1e-4) this._b.set(1, 0, 0)
    this._b.normalize()
    this._c.copy(this._a).cross(this._b).normalize()

    for (let i = 0; i < n; i++) {
      const ang = this._rand() * Math.PI * 2
      const ahead = 1.6 + this._rand() * 4.5
      // A cone, not a cylinder: the radius scales with the distance ahead so
      // every mote sits at least ~30° off the view axis however far away it
      // spawns. A fixed radius put half the wake over the middle of the frame,
      // which is precisely the thing this effect is not allowed to do.
      const rad = ahead * (0.58 + this._rand() * 0.55)
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad
      this._emit(
        camPos.x + this._a.x * ahead + this._b.x * cx + this._c.x * cy,
        camPos.y + this._a.y * ahead + this._b.y * cx + this._c.y * cy,
        camPos.z + this._a.z * ahead + this._b.z * cx + this._c.z * cy,
        // Nearly still in world space: it is the *player* that moves through
        // them at 21 m/s, and letting the world provide the relative motion is
        // what makes a dash feel like the ground giving way under you.
        this._rand2() * 0.5, this._rand2() * 0.4 + 0.2, this._rand2() * 0.5,
        0.34 + this._rand() * 0.22,
        0.045 + this._rand() * 0.050,
        1.6,
        -1.0,
        2.2,
        // Warm and lit, but nothing like spark temperature: this is air the
        // dash has stirred up and caught the sun, not something burning.
        1.7, 1.10, 0.52,
      )
    }
  }

  /** Scrape marks up a vertical wall-run — sparks thrown down behind the boots. */
  climb(dt, x, y, z, nx, ny, nz) {
    this._climbAcc += dt * 60
    let n = Math.floor(this._climbAcc)
    if (n <= 0) return
    if (n > 5) n = 5
    this._climbAcc -= n
    for (let i = 0; i < n; i++) {
      this._emit(
        x + this._rand2() * 0.18, y + this._rand2() * 0.16, z + this._rand2() * 0.18,
        nx * (1.0 + this._rand() * 2.0) + this._rand2() * 0.8,
        // Downward, because you are going up — but only just. Climb speed is
        // 9.2 m/s, so sparks thrown down hard are behind the eye within two
        // frames and the effect is invisible from the only camera we have.
        -0.5 - this._rand() * 1.5,
        nz * (1.0 + this._rand() * 2.0) + this._rand2() * 0.8,
        0.24 + this._rand() * 0.22,
        0.024 + this._rand() * 0.030,
        0.5,
        -14.0,
        1.2,
        3.0, 1.5, 0.4,
      )
    }
  }

  /**
   * Scrape along a LATERAL wall-run — a trail struck off behind the boots.
   *
   * The counterpart of `climb` above, and deliberately not the same picture.
   * A climb throws its sparks *down*, because you are going up; a run throws
   * them *back along the wall*, because you are going sideways. That is the
   * difference between the two moves rendered as a direction, which is the
   * one thing a player can read at a glance while their eyes are on the route.
   *
   * `ax, az` is the unit direction of travel along the surface. Rate rides on
   * speed rather than being fixed: a wall-run barely holding on should not
   * throw the same shower as one taken at a sprint.
   */
  wallrun(dt, x, y, z, nx, ny, nz, ax, az, speed) {
    // 22/s at walking pace up to 52/s flat out. Capped per frame so a hitch
    // cannot dump a hundred particles into one draw.
    this._wallAcc += dt * (22 + Math.min(1, speed / 14) * 30)
    let n = Math.floor(this._wallAcc)
    if (n <= 0) return
    if (n > 4) n = 4
    this._wallAcc -= n
    for (let i = 0; i < n; i++) {
      // Trailing speed is a fraction of the player's, not the full amount: a
      // spark that keeps pace with the boot never separates from it, and the
      // whole read here is separation.
      const back = 0.35 + this._rand() * 0.55
      this._emit(
        x + this._rand2() * 0.16, y + this._rand2() * 0.30, z + this._rand2() * 0.16,
        -ax * speed * back + nx * (0.6 + this._rand() * 1.4) + this._rand2() * 0.5,
        // Barely any vertical: on a lateral run gravity is most of what makes
        // the trail hang behind and fall away, and launching them upward reads
        // as an explosion rather than as a scrape.
        0.2 + this._rand() * 0.7,
        -az * speed * back + nz * (0.6 + this._rand() * 1.4) + this._rand2() * 0.5,
        0.26 + this._rand() * 0.24,
        0.020 + this._rand() * 0.026,
        0.45,
        -11.0,
        2.0,
        // A shade cooler than the climb's sparks (3.0, 1.5, 0.4): a glancing
        // scrape does not strike as hot as boots digging in.
        2.4, 1.35, 0.45,
      )
    }
  }

  /** A soft warm puff — the grapple latching, or letting go. */
  puff(x, y, z, amount) {
    const count = 5 + Math.round(amount * 9)
    for (let i = 0; i < count; i++) {
      const ang = this._rand() * Math.PI * 2
      const sp = 0.8 + this._rand() * 2.4 * amount
      this._emit(
        x + this._rand2() * 0.16, y + this._rand2() * 0.16, z + this._rand2() * 0.16,
        Math.cos(ang) * sp, this._rand2() * sp * 0.7, Math.sin(ang) * sp,
        0.35 + this._rand() * 0.35,
        0.045 + this._rand() * 0.055,
        1.4,
        -6.0,
        2.4,
        2.6, 1.5, 0.55,
      )
    }
  }

  // --------------------------------------------------------------- driving

  /** Viewport height, for the point-size projection. */
  setSize(width, height) {
    this._height = height
  }

  update(dt, camera) {
    this.time += Math.min(dt, 1 / 30)
    this.material.uniforms.uTime.value = this.time
    // Point size in pixels is size * (h/2) * proj[1][1] / -z. The FOV moves
    // with speed, so this is read from the live projection every frame rather
    // than cached at resize — otherwise every mote quietly changes size when
    // the rig opens the lens.
    this.material.uniforms.uPixelScale.value =
      this._height * 0.5 * camera.projectionMatrix.elements[5]

    if (this._dirty) {
      this.geometry.attributes.position.needsUpdate = true
      this.geometry.attributes.aVel.needsUpdate = true
      this.geometry.attributes.aParams.needsUpdate = true
      this.geometry.attributes.aColor.needsUpdate = true
      this.geometry.attributes.aSeed.needsUpdate = true
      this._dirty = false
    }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}

function dynamic(array, itemSize) {
  const a = new THREE.BufferAttribute(array, itemSize)
  a.setUsage(THREE.DynamicDrawUsage)
  return a
}

/**
 * One pool per scene, shared by every effect that needs to throw particles.
 *
 * `SpeedFX` owns the clock: it is the thing that is updated every frame with a
 * dt and a camera, and it drives the field. Everyone else — the grapple, and
 * anything added later — only ever spawns into it. Two pools would mean two
 * draw calls and two buffers to say the same thing.
 */
const FIELDS = new WeakMap()

export function sharedMoteField(scene) {
  let field = FIELDS.get(scene)
  if (!field) {
    field = new MoteField(scene)
    FIELDS.set(scene, field)
  }
  return field
}

/** Tear the pool down and forget it, so a later call builds a live one. */
export function disposeMoteField(scene) {
  const field = FIELDS.get(scene)
  if (!field) return
  scene.remove(field.points)
  field.dispose()
  FIELDS.delete(scene)
}
