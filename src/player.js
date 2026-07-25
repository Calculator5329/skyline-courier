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
  dashSpeed: 15.5,
  dashTime: 0.16,
  dashCooldown: 0.55,

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
    this.airJumpsLeft = TUNING.airJumps
    this.coyote = 0
    this.jumpBuffered = 0
    this.footDistance = 0
    this.landImpact = 0

    /** Drained each frame by the audio + camera layers. */
    this.events = []

    this._wish = new THREE.Vector3()
    this._forward = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._contacts = []
    this._scratch = []
    this._tangent = new THREE.Vector3()
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
  }

  update(dt, input, yaw) {
    const T = TUNING
    this.events.length = 0
    this.wasGrounded = this.grounded

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
      const stride = this.sliding ? 1e9 : (input.sprint ? 2.5 : 2.0)
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
      }
    }
  }

  // ---------------------------------------------------------------- motion

  _groundMove(dt, input, wishing) {
    const T = TUNING
    const friction = this.sliding ? T.slideFriction : T.groundFriction
    const speed = this.speed

    if (speed > 0.01 && (!wishing || this.sliding || speed > T.sprintSpeed)) {
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

  /** Dash and climb triggers. Both are airborne-flow tools. */
  _updateAbilities(dt, input, wishing) {
    const T = TUNING
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
      if (this.sliding) {
        // Slide-hop: leaving a slide through a jump keeps the speed the slide
        // built. This is the main chaining trick the course rewards.
        this.sliding = false
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

  // ------------------------------------------------------------- collision

  _integrate(dt) {
    const T = TUNING
    const vel = this.velocity
    const travel = vel.length() * dt
    const steps = Math.min(8, Math.max(1, Math.ceil(travel / 0.14)))
    const sdt = dt / steps

    this.grounded = false
    this._hitWall = false
    this._wallTop = -Infinity
    let wallNx = 0, wallNy = 0, wallNz = 0

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
          } else if (Math.abs(n.y) < 0.45) {
            this._hitWall = true
            wallNx = n.x; wallNy = n.y; wallNz = n.z
            if (c.top > this._wallTop) this._wallTop = c.top
          }
        }
      }
    }

    if (this._hitWall) this._pendingWall = { x: wallNx, y: wallNy, z: wallNz }
    else this._pendingWall = null

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
    if (this._pendingWall && wishing) {
      const rise = this._wallTop - this.position.y
      if (rise > 0.02 && rise < T.vaultMaxHeight) {
        this._probe.set(this.position.x, this._wallTop + 0.02, this.position.z)
        this._probe.addScaledVector(this._wish, T.radius * 0.9)
        if (this.world.isClear(this._probe, T.radius * 0.95, this.height, this._scratch)) {
          const airborne = !this.grounded
          this.position.copy(this._probe)
          // Mantling out of the air gets a push over the lip; stepping up a
          // stair while running must not launch you, or stairs become a
          // trampoline.
          if (airborne) this.velocity.y = Math.max(this.velocity.y, T.vaultLift)
          else if (this.velocity.y < 0) this.velocity.y = 0
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
