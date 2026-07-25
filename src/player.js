import * as THREE from 'three'

/**
 * First-person momentum controller.
 *
 * The governing rule (docs/taste.md): anything that scrubs speed the player
 * did not choose to scrub is a bug. Ground movement uses Quake-style
 * accelerate-toward-wish-direction rather than a velocity assignment, so speed
 * is something you build and keep rather than something the controller hands
 * you each frame. Air control uses the same function with a low wish-speed
 * cap, which is the classic trick that lets a player who steers well through
 * an arc come out of it *faster* than one who holds W. That skill ceiling is
 * the entire reason this genre feels good.
 */

export const TUNING = {
  radius: 0.34,
  standHeight: 1.75,
  slideHeight: 0.95,
  eyeDrop: 0.22,           // eye sits this far below the crown

  gravity: 26,
  terminalFall: 42,

  walkSpeed: 6.8,
  sprintSpeed: 11.0,
  groundAccel: 70,
  groundFriction: 8.5,
  frictionFloor: 4.0,      // friction never drops below this "control speed"
  // Friction applied while grounded, steering, and ABOVE the sprint cap.
  //
  // Full ground friction here is the single worst momentum leak the controller
  // had: at 21 m/s (a dash) it removes 178 m/s², so a dash or grapple exit was
  // scrubbed back to 11 m/s within 0.08 s of touching a roof — measured, not
  // guessed. The player never asked for that, which makes it a bug by the rule
  // at the top of this file. At 0.9 the same 21 m/s bleeds to sprint over
  // ~0.7 s, which is long enough to carry a boost into the next jump and short
  // enough that it does not become the new cruising speed. Letting go of the
  // stick still hands you the full 8.5 — that deceleration you *did* ask for.
  overspeedFriction: 0.9,
  // How fast a grounded player above the sprint cap can swing their momentum
  // around, in rad/s. Above the cap steering *redirects* velocity instead of
  // adding to it: Quake-style ground acceleration projects onto the wish axis,
  // so with the old friction gone a player who simply held W and swept the
  // mouse accumulated speed out of nothing and pegged the 34 m/s clamp in a
  // few seconds. Turning must never print speed — a dash has to stay the only
  // way to get dash speed. 7 rad/s puts a 90° carve at ~0.35 s, which reads as
  // weight at pace without feeling like ice.
  overspeedTurn: 7.0,

  // One footfall per this much ground covered. Lives here rather than inline
  // because the camera locks its head-bob to the same cadence; when the two
  // drifted apart the view bobbed at 2.6 Hz over footsteps firing at 4.3 Hz,
  // and the mismatch reads as the animation being broken even though both
  // halves are individually fine.
  strideWalk: 2.0,
  strideSprint: 2.5,

  airAccel: 42,
  airWishSpeed: 2.6,       // the strafe-gain cap — small on purpose

  jumpSpeed: 8.6,
  coyoteTime: 0.12,
  jumpBuffer: 0.14,
  // One mid-air jump, restored on landing or on touching a wall. It reads as
  // the courier's clockwork cape catching air — and mechanically it is a
  // recovery tool: a mistimed gap jump stays survivable, which is what keeps
  // a fast run feeling committed instead of cautious.
  airJumps: 1,
  airJumpSpeed: 7.6,

  slideMinSpeed: 5.0,
  slideBoost: 2.4,
  // A slide has to survive the whole underpass at entry speed, or the player
  // gets punished for executing it correctly. Tuned so ~12 m/s carries about
  // 18 m before dropping under the exit threshold.
  slideFriction: 0.35,
  slideDownhillPull: 9.0,
  slideHopBoost: 1.6,
  // Coyote time for the slide-hop. Nobody releases crouch and presses jump on
  // the same frame; they let go of Ctrl first and then hit Space. Without this
  // grace the stance update stands you up before `_tryJump` runs, the hop
  // boost never applies, and the natural input is *slower* out of a slide than
  // simply holding Ctrl through it — a trick move that punishes the intuitive
  // hands. Same philosophy as coyoteTime: honour what the player meant.
  slideHopGrace: 0.15,

  wallRunTime: 1.6,
  wallRunMinSpeed: 4.6,
  wallRunGravity: 0.16,    // fraction of normal gravity while attached
  wallRunLift: 2.2,        // one-off upward nudge on attach when falling
  wallRunStick: 5.0,
  wallJumpOut: 7.0,
  wallJumpUp: 7.8,
  wallRegrabCooldown: 0.22,
  // Wall-running detects walls by *probing* out to this distance rather than
  // waiting for the capsule to physically graze one. Requiring real contact
  // means the player has to scrape along a surface to stay attached, which
  // reads as broken even when it is working exactly as written. Every game
  // that gets this right gives the wall a reach.
  wallReach: 0.55,

  // Generous on purpose: catching a ledge you *nearly* missed is the single
  // biggest contributor to parkour feeling fluid rather than fussy. Dying
  // Light and Forspoken both err heavily on the side of "you made it".
  vaultMaxHeight: 1.45,
  vaultLift: 2.4,

  // --- wall-run carry ---------------------------------------------------
  // A wall that bleeds your speed is a wall you learn to avoid. Attaching
  // should preserve what you arrived with and gently drive you along the
  // surface, so the wall reads as a fast line rather than an obstacle.
  wallRunAccel: 26,
  wallRunCarry: 1.04,      // target along-wall speed, as a multiple of entry

  // --- vertical wall-run (Dying Light / Forspoken) ----------------------
  climbSpeed: 9.2,
  climbTime: 0.5,
  climbMinSpeed: 5.5,
  climbCooldown: 0.5,

  // --- air dash (Mirror's Edge "shift" / Forspoken flow) ----------------
  // Punchier and longer-reaching, paid for with a longer cooldown: a dash you
  // can spam is a dash with no decision in it. Now it clears a gap outright,
  // so choosing *when* to spend it is the interesting part.
  dashSpeed: 21.0,
  dashTime: 0.22,
  dashCooldown: 0.9,
  // There is deliberately no `dashExitSpeed` clamp. The burst simply ends and
  // `overspeedFriction` bleeds what is left, so how much of the dash you carry
  // depends on what you do next rather than on a constant. (A dead
  // `dashExitSpeed: 14.0` sat here for a while, read by nothing.)

  // --- grapple: the courier's brass cuff ---------------------------------
  // The fiction has called for this since docs/intent.md was written. It
  // latches onto brass anchors, which doubles as level language: brass has
  // always meant "you can use this", and now it means it at range too.
  grappleRange: 34,
  grappleMinRange: 5,
  grappleAim: 0.965,       // cos of the max angle off the look axis
  grapplePull: 30.0,       // acceleration toward the anchor
  grappleMaxTime: 1.5,
  grappleReleaseBoost: 1.14,
  grappleCooldown: 0.7,
  grappleArriveDist: 3.2,

  maxSpeed: 34,
}

const UP = new THREE.Vector3(0, 1, 0)

export class Player {
  constructor(world, spawn) {
    this.world = world
    this.position = spawn.clone()
    this.velocity = new THREE.Vector3()

    this.height = TUNING.standHeight
    this.grounded = false
    this.wasGrounded = false
    this.sliding = false
    this.wallRunning = false
    this.wallNormal = new THREE.Vector3()
    this.wallSide = 0            // -1 wall on the left, +1 on the right
    this.wallTimer = TUNING.wallRunTime
    this.wallCooldown = 0
    this.wallEntrySpeed = 0
    this.climbTimer = 0
    this.climbCooldown = 0
    this.dashTimer = 0
    this.dashCooldown = 0
    this.dashReady = true
    this.grappling = false
    this.grappleTimer = 0
    this.grappleCooldown = 0
    this.grappleAnchor = new THREE.Vector3()
    /** Populated by the level: brass anchor points the cuff can latch onto. */
    this.anchors = []
    /** The anchor currently in range and on-axis, or null. Read by the HUD. */
    this.aimedAnchor = null
    this.airJumpsLeft = TUNING.airJumps
    this.coyote = 0
    this.jumpBuffered = 0
    this.slideGrace = 0
    this.footDistance = 0
    this.landImpact = 0
    /**
     * Metres the body was teleported straight up by a step-up or mantle this
     * frame, 0 otherwise.
     *
     * Published for the camera, which has to absorb it: the body legitimately
     * jumps up to `vaultMaxHeight` in a single frame, and a view that follows
     * that literally reads as a glitch rather than as a mantle. Handing over
     * the exact number beats any heuristic the rig could run on the position,
     * and it stays correct no matter how many sim steps a render frame took.
     */
    this.stepUp = 0
    /** Horizontal speed at the top of the frame, before collision flattens it. */
    this._preSpeed = 0

    /** Drained each frame by the audio + camera layers. */
    this.events = []

    this._wish = new THREE.Vector3()
    this._forward = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._contacts = []
    this._scratch = []
    this._tangent = new THREE.Vector3()
    this._look = new THREE.Vector3(0, 0, -1)
    this._toAnchor = new THREE.Vector3()
    this._yaw = 0
    this._pitch = 0
    this._probe = new THREE.Vector3()
    this._hitWall = false
    this._wallTop = 0
    this._wallHit = { found: false, nx: 0, ny: 0, nz: 0, side: 0 }
  }

  /**
   * Probe for a wall in one specific horizontal direction.
   *
   * Shares the `_wallHit` record with `_probeWall`; only one probe is ever
   * live at a time, and every caller consumes the result immediately.
   */
  _probeDir(dx, dz, side) {
    const T = TUNING
    const hit = this._wallHit
    hit.found = false

    this._probe.copy(this.position)
    this._probe.x += dx * T.wallReach
    this._probe.z += dz * T.wallReach

    const contacts = this.world.resolve(this._probe, T.radius, this.height, this._scratch)
    for (let i = 0; i < contacts.length; i++) {
      const n = contacts[i].normal
      if (Math.abs(n.y) >= 0.45) continue
      // A genuine wall in that direction faces back toward us.
      if (n.x * dx + n.z * dz >= 0) continue
      hit.found = true
      hit.nx = n.x; hit.ny = n.y; hit.nz = n.z; hit.side = side
      return hit
    }
    return hit
  }

  /**
   * Look for a wall within arm's reach on either side.
   *
   * Returns the shared `_wallHit` record (never allocates). `side` is -1 when
   * the wall is on the player's left, +1 on the right, which is what drives
   * the camera roll.
   */
  _probeWall() {
    const T = TUNING
    const hit = this._wallHit
    hit.found = false

    for (let s = -1; s <= 1; s += 2) {
      const found = this._probeDir(this._right.x * s, this._right.z * s, s)
      if (found.found) return found
    }
    hit.found = false
    return hit
  }

  get speed() {
    return Math.hypot(this.velocity.x, this.velocity.z)
  }

  /**
   * Full 3D speed, for anything the player *feels* rather than anything the
   * movement rules act on.
   *
   * Horizontal speed is constant while airborne — there is no drag — so a
   * readout driven by `speed` alone appears frozen for the whole flight and
   * only twitches on contact. That is physically right and experientially
   * wrong: a long fall is the fastest you ever move.
   */
  get speed3d() {
    return this.velocity.length()
  }

  get eyeHeight() {
    return this.height - TUNING.eyeDrop
  }

  teleport(pos) {
    this.position.copy(pos)
    this.velocity.set(0, 0, 0)
    this.wallRunning = false
    this.sliding = false
    this.height = TUNING.standHeight
    this.wallTimer = TUNING.wallRunTime
    this.slideGrace = 0
  }

  update(dt, input, yaw, pitch = 0) {
    const T = TUNING
    this.events.length = 0
    this.stepUp = 0
    this.wasGrounded = this.grounded
    this._yaw = yaw
    this._pitch = pitch

    // --- wish direction, in the camera's yaw frame ----------------------
    this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw))
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw))
    this._wish
      .copy(this._forward).multiplyScalar(input.forward)
      .addScaledVector(this._right, input.right)
    const wishing = this._wish.lengthSq() > 1e-6
    if (wishing) this._wish.normalize()

    // --- input latches ---------------------------------------------------
    // Buffering and coyote time exist so the game never eats a jump the
    // player fairly earned. Both are generous by design.
    this.jumpBuffered = input.jumpPressed ? T.jumpBuffer : Math.max(0, this.jumpBuffered - dt)
    // Holding jump keeps the request alive while grounded, so landing with the
    // key down hops straight back out. Chaining jumps should not require
    // frame-perfect re-taps — that is dexterity testing, not flow.
    if (input.jumpHeld && this.grounded) this.jumpBuffered = T.jumpBuffer
    this.wallCooldown = Math.max(0, this.wallCooldown - dt)
    // Decayed before `_updateStance`, which is what re-arms it on slide exit.
    this.slideGrace = Math.max(0, this.slideGrace - dt)

    this._updateStance(input)
    this._updateAbilities(dt, input, wishing)

    if (this.dashTimer > 0) {
      // A dash owns the player's velocity outright for its duration. Letting
      // ground friction and the normal accelerate() run during it immediately
      // drags the burst back down to sprint speed, so the dash "fires" but
      // nothing visibly happens — which is exactly what a broken dash looks
      // like from the outside.
      this.coyote = T.coyoteTime
      this._airMove(dt, input, wishing)
    } else if (this.grounded) {
      this.coyote = T.coyoteTime
      this.wallTimer = T.wallRunTime
      this.wallRunning = false
      this._groundMove(dt, input, wishing)
    } else {
      this.coyote = Math.max(0, this.coyote - dt)
      this._airMove(dt, input, wishing)
    }

    this._tryJump()

    // Clamp only the truly absurd; the cap is a safety rail, not a governor.
    const horiz = this.speed
    // Captured before collision flattens it — the climb check needs to know
    // how fast the player *arrived*, not what survived the impact.
    this._preSpeed = horiz
    if (horiz > T.maxSpeed) {
      const s = T.maxSpeed / horiz
      this.velocity.x *= s
      this.velocity.z *= s
    }
    if (this.velocity.y < -T.terminalFall) this.velocity.y = -T.terminalFall

    const fallSpeed = this.velocity.y
    this._integrate(dt)
    this._resolveTransitions(fallSpeed, input, wishing)

    if (this.grounded && horiz > 0.5) {
      this.footDistance += horiz * dt
      const stride = this.sliding ? 1e9 : (input.sprint ? T.strideSprint : T.strideWalk)
      if (this.footDistance > stride) {
        this.footDistance = 0
        this.events.push({ type: 'step', speed: horiz })
      }
    }
  }

  // ---------------------------------------------------------------- stance

  _updateStance(input) {
    const T = TUNING
    const wantSlide = input.slide && this.grounded && this.speed > T.slideMinSpeed

    if (wantSlide && !this.sliding) {
      this.sliding = true
      this.height = T.slideHeight
      // The entry boost is the reward for sliding at the right moment rather
      // than holding crouch the whole run.
      const s = this.speed
      if (s > 0.01) {
        const k = (s + T.slideBoost) / s
        this.velocity.x *= k
        this.velocity.z *= k
      }
      this.events.push({ type: 'slide', speed: s })
    } else if (this.sliding && (!input.slide || this.speed < 3.0 || !this.grounded)) {
      // Only stand back up if there is actually room to.
      this._probe.copy(this.position)
      if (this.world.isClear(this._probe, T.radius * 0.98, T.standHeight, this._scratch)) {
        this.sliding = false
        this.height = T.standHeight
        this.slideGrace = T.slideHopGrace
      }
    }
  }

  // ---------------------------------------------------------------- motion

  _groundMove(dt, input, wishing) {
    const T = TUNING
    const speed = this.speed

    // How much of the current velocity is going where the player is steering.
    // -1 is dead against it, +1 is straight along it.
    const along = (wishing && speed > 0.01)
      ? (this.velocity.x * this._wish.x + this.velocity.z * this._wish.z) / speed
      : 0

    // Four friction regimes, and the whole distinction is *who asked for the
    // slowdown*. Steering below the cap: none, so accelerating feels immediate.
    // Steering forward above it: a slow bleed, because speed you earned with a
    // dash, a grapple or a slide is yours until you spend it. Steering against
    // your own momentum, or not steering at all: the full brake, because those
    // are the two cases where the player genuinely asked to stop.
    let friction = 0
    if (this.sliding) friction = T.slideFriction
    else if (!wishing) friction = T.groundFriction
    else if (speed > T.sprintSpeed) friction = along > 0 ? T.overspeedFriction : T.groundFriction

    if (speed > 0.01 && friction > 0) {
      const drop = Math.max(speed, T.frictionFloor) * friction * dt
      const next = Math.max(0, speed - drop)
      const k = next / speed
      this.velocity.x *= k
      this.velocity.z *= k
    }

    if (this.sliding) {
      // A slide is steered, not driven — you keep what you brought into it.
      if (wishing) accelerate(this.velocity, this._wish, 3.0, 14, dt)
      return
    }
    if (!wishing) return

    if (this.speed > T.sprintSpeed) {
      // Above the cap the wish direction steers momentum rather than feeding
      // it. See `overspeedTurn`: running accelerate() here instead lets a mouse
      // sweep manufacture speed the player never earned.
      steerHorizontal(this.velocity, this._wish, T.overspeedTurn, dt)
      return
    }

    const target = input.sprint ? T.sprintSpeed : T.walkSpeed
    accelerate(this.velocity, this._wish, target, T.groundAccel, dt)
  }

  _airMove(dt, input, wishing) {
    const T = TUNING
    const vel = this.velocity

    // --- vertical wall-run: gravity is simply off while climbing ---------
    if (this.climbTimer > 0) {
      // Ease out rather than cutting: the climb decelerates into its apex so
      // the player can read where they will end up and mantle from there.
      const k = this.climbTimer / T.climbTime
      vel.y = T.climbSpeed * (0.35 + 0.65 * k)
      vel.addScaledVector(this.wallNormal, -T.wallRunStick * dt)
      return
    }

    // --- grapple: accelerate along the line to the anchor -----------------
    if (this.grappling) {
      this._toAnchor.subVectors(this.grappleAnchor, this.position)
      const dist = this._toAnchor.length()
      if (dist > 0.001) this._toAnchor.divideScalar(dist)
      // Gravity is reduced but not cancelled, so a long grapple still arcs.
      // A perfectly straight pull reads as being on rails.
      vel.y -= T.gravity * 0.28 * dt
      vel.addScaledVector(this._toAnchor, T.grapplePull * dt)
      return
    }

    // --- air dash: also suspends gravity, for a clean readable burst -----
    if (this.dashTimer > 0) {
      vel.y *= 0.82
      return
    }

    const g = this.wallRunning ? T.gravity * T.wallRunGravity : T.gravity
    vel.y -= g * dt

    if (this.wallRunning) {
      this.wallTimer -= dt
      // Hold the player against the wall so a small steering error does not
      // silently drop them off it.
      vel.addScaledVector(this.wallNormal, -T.wallRunStick * dt)

      // Drive along the wall so attaching *carries* speed instead of costing
      // it. Without this the wall reads as a brake and players stop using it.
      this._tangent.set(vel.x, 0, vel.z)
      const tl = this._tangent.length()
      if (tl > 0.01) {
        this._tangent.divideScalar(tl)
        accelerate(vel, this._tangent, this.wallEntrySpeed * T.wallRunCarry, T.wallRunAccel, dt)
      }
      if (this.wallTimer <= 0) this._detachWall()
    }

    if (wishing) accelerate(vel, this._wish, T.airWishSpeed, T.airAccel, dt)
  }

  /**
   * Find the best brass anchor the cuff could latch onto right now.
   *
   * Scored by how close the anchor is to the centre of the view rather than
   * by raw distance: when two anchors are both valid the player almost always
   * means the one they are looking straight at, not the nearer one off to the
   * side. Runs every frame so the reticle can light up before you commit.
   */
  _findAnchor() {
    const T = TUNING
    let best = null
    let bestScore = T.grappleAim

    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i]
      this._toAnchor.subVectors(a, this.position)
      const dist = this._toAnchor.length()
      if (dist < T.grappleMinRange || dist > T.grappleRange) continue
      this._toAnchor.divideScalar(dist)

      const aim = this._toAnchor.x * this._look.x +
                  this._toAnchor.y * this._look.y +
                  this._toAnchor.z * this._look.z
      if (aim > bestScore) { bestScore = aim; best = a }
    }
    return best
  }

  /** Dash, climb and grapple triggers. All three are airborne-flow tools. */
  _updateAbilities(dt, input, wishing) {
    const T = TUNING
    this.grappleCooldown = Math.max(0, this.grappleCooldown - dt)

    // The full 3D look axis, for aiming. Kept separate from `_forward`, which
    // is the *horizontal* movement basis — overwriting that with a pitched
    // vector silently shortens every wall probe when you look up or down.
    const cp = Math.cos(this._pitch)
    this._look.set(-Math.sin(this._yaw) * cp, Math.sin(this._pitch), -Math.cos(this._yaw) * cp)

    this.aimedAnchor = (this.grappleCooldown <= 0 && !this.grappling)
      ? this._findAnchor()
      : null

    if (this.grappling) {
      this.grappleTimer -= dt
      const reached = this.position.distanceTo(this.grappleAnchor) < T.grappleArriveDist
      // Release on: letting go, running out of line, arriving, or landing.
      if (!input.grappleHeld || this.grappleTimer <= 0 || reached || this.grounded) {
        this._releaseGrapple(reached)
      }
    } else if (input.grapplePressed && this.aimedAnchor) {
      this.grappling = true
      this.grappleTimer = T.grappleMaxTime
      this.grappleAnchor.copy(this.aimedAnchor)
      this.grappleCooldown = T.grappleCooldown
      this.dashReady = true          // latching on refreshes the dash
      this.airJumpsLeft = T.airJumps
      this._detachWall()
      this.events.push({ type: 'grapple', speed: this.speed })
    }

    this.dashCooldown = Math.max(0, this.dashCooldown - dt)
    this.climbCooldown = Math.max(0, this.climbCooldown - dt)
    this.dashTimer = Math.max(0, this.dashTimer - dt)
    if (this.climbTimer > 0) {
      this.climbTimer = Math.max(0, this.climbTimer - dt)
      if (this.climbTimer === 0) this.climbCooldown = T.climbCooldown
    }
    // Landing cancels a climb outright — clinging to a wall you already left
    // is how a player ends up fighting the controller.
    if (this.grounded) this.climbTimer = 0

    // Landing and attaching to a wall both restore the dash, so a good line
    // gets to use it repeatedly and a flailing one does not.
    if (this.grounded || this.wallRunning) {
      this.dashReady = true
      this.airJumpsLeft = T.airJumps
    }

    if (input.dashPressed && this.dashReady && this.dashCooldown <= 0 && this.dashTimer <= 0) {
      this.dashReady = false
      this.dashCooldown = T.dashCooldown
      this.dashTimer = T.dashTime
      // Dash where you are steering; fall back to where you are looking.
      const dir = wishing ? this._wish : this._forward
      this.velocity.x = dir.x * T.dashSpeed
      this.velocity.z = dir.z * T.dashSpeed
      if (this.velocity.y < 0) this.velocity.y *= 0.25
      this.events.push({ type: 'dash', speed: T.dashSpeed })
    }
  }

  _tryJump() {
    const T = TUNING
    if (this.jumpBuffered <= 0) return

    // Ground jump wins when both are available — a player standing next to a
    // wall pressing space means "jump", not "wall-jump".
    if (this.grounded || this.coyote > 0) {
      this.jumpBuffered = 0
      this.coyote = 0
      this.grounded = false
      this.velocity.y = T.jumpSpeed
      if (this.sliding || this.slideGrace > 0) {
        // Slide-hop: leaving a slide through a jump keeps the speed the slide
        // built. This is the main chaining trick the course rewards, and the
        // grace window means it fires whether you held Ctrl through the jump
        // or let go of it first (see `slideHopGrace`).
        this.sliding = false
        this.slideGrace = 0
        this.height = T.standHeight
        const s = this.speed
        if (s > 0.01) {
          const k = (s + T.slideHopBoost) / s
          this.velocity.x *= k
          this.velocity.z *= k
        }
      }
      this.events.push({ type: 'jump', speed: this.speed })
      return
    }

    // Airborne: a wall within reach is jumpable whether or not we ever
    // formally attached to it. Requiring an active wall-run first is the
    // difference between "wall-jump is broken" and "wall-jump is generous".
    // Wall-jumps take priority over the air jump — if a wall is there, that
    // is almost always the move the player meant.
    if (this.wallCooldown <= 0) {
      let nx = 0, nz = 0, have = false
      if (this.wallRunning) {
        nx = this.wallNormal.x; nz = this.wallNormal.z; have = true
      } else {
        const hit = this._probeWall()
        if (hit.found) { nx = hit.nx; nz = hit.nz; have = true }
      }

      if (have) {
        this.jumpBuffered = 0
        this.velocity.x += nx * T.wallJumpOut
        this.velocity.z += nz * T.wallJumpOut
        this.velocity.y = Math.max(this.velocity.y, 0) + T.wallJumpUp
        this.wallCooldown = T.wallRegrabCooldown
        // Each wall-jump earns back part of the wall budget, so a clean chain
        // across alternating walls can keep going.
        this.wallTimer = Math.min(T.wallRunTime, this.wallTimer + 0.6)
        this._detachWall()
        this.events.push({ type: 'walljump', speed: this.speed })
        return
      }
    }

    // --- air jump ---------------------------------------------------------
    // A press made just before touchdown means "jump the moment I land", not
    // "spend the double jump at knee height". Without this guard the air jump
    // always won the race: pressing Space 0.04 s before a roof burned the
    // charge at y = 0.77 m and produced a *weaker* hop than simply waiting
    // (airJumpSpeed 7.6 vs jumpSpeed 8.6), which is the exact opposite of what
    // the player asked for. We only hold the press when the buffer is provably
    // long enough to reach the floor, so a press that could never be honoured
    // on landing still becomes an air jump — the buffer is never eaten.
    if (this.velocity.y < -0.5 && this._floorWithinFall(this.jumpBuffered)) return

    if (this.airJumpsLeft > 0) {
      this.airJumpsLeft--
      this.jumpBuffered = 0
      // Reset rather than add: a double jump that stacks on residual upward
      // velocity gives wildly different heights depending on when you tapped,
      // which makes it unreadable. A flat reset is always the same jump.
      this.velocity.y = T.airJumpSpeed
      // Steering into the second jump redirects it — this is the bit that
      // makes it feel like an ability rather than a second Space press.
      if (this._wish.lengthSq() > 1e-6) {
        const s = Math.max(this.speed, TUNING.walkSpeed)
        this.velocity.x = this._wish.x * s
        this.velocity.z = this._wish.z * s
      }
      this.events.push({ type: 'airjump', speed: this.speed })
    }
  }

  /**
   * Is there floor close enough below that we will certainly land within
   * `time` seconds at the current fall rate?
   *
   * Only called on the handful of frames where a jump is buffered mid-air, and
   * it borrows the shared probe/scratch, so it allocates nothing. The 0.75
   * factor is deliberate pessimism: a player drifting sideways off the ledge
   * we just probed must fall through to the air jump rather than sit on a
   * buffered press that never gets honoured. Because it re-runs every frame
   * with the shrinking remainder of the buffer, that fallback happens on its
   * own while there is still buffer left to spend.
   */
  _floorWithinFall(time) {
    const fall = -this.velocity.y * time * 0.75
    if (fall < 0.02) return false
    this._probe.copy(this.position)
    this._probe.y -= fall
    const below = this.world.resolve(this._probe, TUNING.radius, this.height, this._scratch)
    for (let i = 0; i < below.length; i++) {
      if (below[i].normal.y > 0.7) return true
    }
    return false
  }

  // ------------------------------------------------------------- collision

  _integrate(dt) {
    const T = TUNING
    const vel = this.velocity
    const travel = vel.length() * dt
    const steps = Math.min(8, Math.max(1, Math.ceil(travel / 0.14)))
    const sdt = dt / steps

    this.grounded = false
    this._ledge = false
    this._wallTop = -Infinity

    for (let s = 0; s < steps; s++) {
      this.position.addScaledVector(vel, sdt)

      // A few relaxation passes settle corners without a full LCP solve.
      for (let pass = 0; pass < 3; pass++) {
        const contacts = this.world.resolve(this.position, T.radius, this.height, this._contacts)
        if (contacts.length === 0) break

        for (let i = 0; i < contacts.length; i++) {
          const c = contacts[i]
          const n = c.normal
          this.position.addScaledVector(n, c.depth)

          const vn = vel.dot(n)
          if (vn < 0) vel.addScaledVector(n, -vn)

          if (n.y > 0.7) {
            this.grounded = true
          } else if (n.y > -0.45) {
            // Everything that is neither floor nor ceiling is a step-up
            // candidate, and the band matters more than it looks.
            //
            // The old test was `|n.y| < 0.45`, i.e. near-vertical faces only.
            // But the capsule's bottom hemisphere never *reaches* a vertical
            // face on anything shorter than its own radius (0.34 m): it meets
            // the top EDGE, and the normal from the capsule axis to that edge
            // comes back tilted around n.y ≈ 0.5. That fell through both
            // branches, so a 20 cm kerb was never offered to the step-up path
            // and was resolved as a ramp instead — measured at 11 m/s in, 2.95
            // m/s out, with 4.9 m/s of the difference converted into an
            // unasked-for hop. Every kerb, cornice and stair nosing in the
            // course did that. Widening the band hands those contacts to the
            // vault path, which steps onto them and keeps the speed.
            this._ledge = true
            if (c.top > this._wallTop) this._wallTop = c.top
          }
        }
      }
    }

    // At exact rest the capsule sits *touching* the floor with zero
    // penetration, so the contact query finds nothing and `grounded` flickers
    // off — which would drop friction, break the verb readout, and make a
    // standing jump depend on coyote time. A short downward probe settles it.
    if (!this.grounded && vel.y <= 0.05) {
      this._probe.copy(this.position)
      this._probe.y -= 0.06
      const below = this.world.resolve(this._probe, T.radius, this.height, this._scratch)
      for (let i = 0; i < below.length; i++) {
        if (below[i].normal.y > 0.7) { this.grounded = true; break }
      }
    }
  }

  /**
   * Everything that reads the collision result: landing, vaulting, and
   * attaching to a wall. Kept after `_integrate` because it re-queries the
   * world, which recycles the contact pool.
   */
  _resolveTransitions(fallSpeed, input, wishing) {
    const T = TUNING

    if (this.grounded && !this.wasGrounded) {
      this.landImpact = Math.min(1, Math.max(0, (-fallSpeed - 3) / 14))
      if (this.landImpact > 0.02) {
        this.events.push({ type: 'land', impact: this.landImpact, speed: this.speed })
      }
    }

    // --- vault / step-up -------------------------------------------------
    // This runs whether or not we are on the ground. A grounded player who
    // walks into a knee-high ledge and simply *stops* is the single most
    // damning movement bug a parkour game can have, and it silently breaks
    // every staircase in the level as well.
    if (this._ledge && wishing) {
      const rise = this._wallTop - this.position.y
      if (rise > 0.02 && rise < T.vaultMaxHeight) {
        this._probe.set(this.position.x, this._wallTop + 0.02, this.position.z)
        this._probe.addScaledVector(this._wish, T.radius * 0.9)
        if (this.world.isClear(this._probe, T.radius * 0.95, this.height, this._scratch)) {
          const airborne = !this.grounded
          this.stepUp = this._probe.y - this.position.y
          this.position.copy(this._probe)
          // Mantling out of the air gets a push over the lip; stepping up a
          // stair while running must not launch you, or stairs become a
          // trampoline.
          if (airborne) {
            this.velocity.y = Math.max(this.velocity.y, T.vaultLift)
          } else {
            // A grounded step-up must never leave you rising faster than you
            // already were. `fallSpeed` is this frame's pre-collision vertical
            // velocity, so a real jump (which is airborne by then anyway) is
            // untouched while the upward kick a kerb collision manufactures is
            // discarded along with the ramp it came from.
            this.velocity.y = Math.min(this.velocity.y, Math.max(fallSpeed, 0))
          }
          // Give back the horizontal speed the collision solver cancelled when
          // the capsule touched the riser. It zeroes the component *into* the
          // wall, and on a head-on ledge that is the entire velocity — which is
          // why a sprint into a 0.6 m lip used to come out the other side at
          // 6.4 m/s, and why an eight-step staircase dropped an 11 m/s run to
          // 0.33 m/s. intent.md promises a mantle "keeps momentum through the
          // top"; this is the line that makes that true. `_preSpeed` is this
          // frame's pre-collision speed, so the player is handed back exactly
          // what they arrived with and never more.
          const carry = Math.max(this.speed, this._preSpeed)
          this.velocity.x = this._wish.x * carry
          this.velocity.z = this._wish.z * carry
          this.grounded = true
          this.wallRunning = false
          if (airborne || rise > 0.35) {
            this.events.push({ type: 'vault', speed: this.speed })
          }
          return
        }
      }
    }

    // Climbing is checked before the grounded early-return because you start
    // a vertical wall-run by sprinting at a wall *from the ground*.
    if (this._tryClimb(input)) return

    if (this.grounded) {
      this.wallRunning = false
      if (this.sliding) {
        // Sliding down a slope should build speed, not bleed it.
        const s = this.speed
        if (s > 0.01 && this.velocity.y < -0.5) {
          accelerate(this.velocity, this._wish, s + T.slideDownhillPull, 6, 0.016)
        }
      }
      return
    }

    // Wall-running is driven by the probe, not by collision contacts, so it
    // runs whether or not we physically touched anything this frame.
    this._updateWallRun(input, wishing)
  }

  /**
   * Vertical wall-run: sprint square into a wall and run *up* it.
   *
   * The subtlety is that by the time this runs, the collision solver has
   * already cancelled the velocity component into the wall — so the player's
   * measured speed is near zero at exactly the moment we need to know how
   * fast they hit it. We test the pre-collision speed captured in `update`,
   * and the steering direction rather than the (now flattened) velocity.
   */
  _tryClimb(input) {
    const T = TUNING

    // The wall we are climbing is *in front of us*, not beside us, so this
    // probes along the steering direction. Reusing the lateral probe here was
    // why running square into a wall did nothing at all: the side probes
    // sweep past a head-on wall and never touch it.
    if (this.climbTimer > 0) {
      const held = this._probeDir(this._forward.x, this._forward.z, 0)
      if (!held.found) { this.climbTimer = 0; this.climbCooldown = T.climbCooldown; return false }
      this.wallNormal.set(held.nx, held.ny, held.nz).normalize()
      this.grounded = false
      return true
    }

    if (this.climbCooldown > 0 || input.forward <= 0) return false
    if (this._preSpeed < T.climbMinSpeed) return false

    const hit = this._probeDir(this._wish.x, this._wish.z, 0)
    if (!hit.found) return false

    // Steering must be squarely into the wall, not sliding along it — that
    // case is a lateral wall-run and is handled separately.
    if (-(this._wish.x * hit.nx + this._wish.z * hit.nz) < 0.5) return false

    this.climbTimer = T.climbTime
    this.wallNormal.set(hit.nx, hit.ny, hit.nz).normalize()
    this.wallSide = 0
    this.grounded = false
    this.dashReady = true
    this.events.push({ type: 'climb', speed: this._preSpeed })
    return true
  }

  /**
   * Attach to, hold, or drop off a wall.
   *
   * Runs every airborne frame from the probe rather than from collision
   * contacts, so the player rides the wall at a natural stand-off distance
   * instead of having to grind against it.
   */
  _updateWallRun(input, wishing) {
    const T = TUNING
    const hit = this._probeWall()

    if (!hit.found) {
      this._detachWall()
      return
    }

    const canAttach =
      this.wallCooldown <= 0 &&
      this.wallTimer > 0 &&
      this.speed > T.wallRunMinSpeed &&
      input.forward > 0 &&
      // Must be travelling along the wall, not into or away from it. The
      // window is wide on purpose: a wall-run you can only enter on a perfect
      // approach angle is a wall-run the player will believe is broken.
      (this.velocity.x * hit.nx + this.velocity.z * hit.nz) < this.speed * 0.6

    if (!canAttach) {
      if (this.wallRunning) this._detachWall()
      return
    }

    if (!this.wallRunning) {
      this.wallRunning = true
      // Remember what the player arrived with; the wall's job is to give it
      // back, not to average them down to a wall-run constant.
      this.wallEntrySpeed = Math.max(this.speed, T.sprintSpeed)
      if (this.velocity.y < 0) {
        this.velocity.y = Math.max(this.velocity.y * 0.25, 0) + T.wallRunLift
      }
      this.events.push({ type: 'wallrun', speed: this.speed })
    }
    this.wallNormal.set(hit.nx, hit.ny, hit.nz).normalize()
    this.wallSide = hit.side
  }

  /**
   * Let go of the line.
   *
   * Releasing multiplies speed rather than adding to it, so a fast approach
   * is rewarded proportionally — the grapple amplifies a good line instead of
   * normalising every arrival to the same exit velocity.
   */
  _releaseGrapple(reached) {
    if (!this.grappling) return
    this.grappling = false
    this.grappleTimer = 0
    if (reached) {
      this.velocity.multiplyScalar(TUNING.grappleReleaseBoost)
      // A little lift on arrival so you clear the anchor you just flew at
      // instead of clipping its underside.
      this.velocity.y = Math.max(this.velocity.y, 3.2)
    }
    this.events.push({ type: 'grapplerelease', speed: this.speed })
  }

  _detachWall() {
    if (!this.wallRunning) return
    this.wallRunning = false
    this.wallSide = 0
  }
}

/**
 * Quake's acceleration: only ever adds speed along `dir`, and only up to the
 * point where the projection of velocity onto `dir` reaches `wishSpeed`. With
 * a small wishSpeed in air this is what produces strafe gain.
 */
/**
 * Rotate horizontal velocity toward `dir` at `rate` rad/s, preserving its
 * magnitude exactly.
 *
 * The counterpart to `accelerate` for the overspeed case: the player keeps
 * every metre per second they earned and can still aim it, but the act of
 * turning neither adds nor removes any. Renormalising the blended direction is
 * what guarantees that — a plain vector lerp would shorten the vector on every
 * turn and quietly tax the corner.
 */
function steerHorizontal(vel, dir, rate, dt) {
  const sp = Math.hypot(vel.x, vel.z)
  if (sp < 1e-4) return
  const k = 1 - Math.exp(-rate * dt)
  const cx = vel.x / sp, cz = vel.z / sp
  const nx = cx + (dir.x - cx) * k
  const nz = cz + (dir.z - cz) * k
  const l = Math.hypot(nx, nz)
  // Degenerate only when the wish is exactly opposite to the current heading;
  // the full-brake friction regime is already handling that case.
  if (l < 1e-3) return
  vel.x = (nx / l) * sp
  vel.z = (nz / l) * sp
}

function accelerate(vel, dir, wishSpeed, accel, dt) {
  const current = vel.x * dir.x + vel.z * dir.z
  const add = wishSpeed - current
  if (add <= 0) return
  let a = accel * wishSpeed * dt
  if (a > add) a = add
  vel.x += dir.x * a
  vel.z += dir.z * a
}

export { UP }
