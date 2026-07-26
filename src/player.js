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

/**
 * The base tuning — this is FUN mode, verbatim, and it is the reference the
 * whole course is built against (docs/course-design.md).
 *
 * Do not edit a number here to make an obstacle harder. That is a standing
 * decision (docs/intent.md): "the design response to 'this trivialises the
 * course' is build a bigger course, never reduce the ability." Difficulty
 * modes are the sanctioned alternative, and they are expressed as an *overlay*
 * on top of this table (see `MODES`), never as an edit to it.
 */
const BASE_TUNING = {
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

  // --- air steering -------------------------------------------------------
  // `airWishSpeed` alone gives Quake air control: it can only ADD speed along
  // the wish direction, up to a 2.6 m/s projection. That is a fine skill
  // ceiling and a terrible steering wheel — at 20 m/s it can barely bend the
  // arc, so a jump feels committed the instant you leave the ground.
  // (Ethan: "you're like forced into whatever direction you're jumping and
  // you can't redirect like mid jump".)
  //
  // So steering is a separate mechanism: rotate the existing horizontal
  // velocity toward where the player is steering, at a bounded turn rate,
  // WITHOUT changing its magnitude. It cannot create or destroy speed, so the
  // strafe-gain ceiling above is untouched — it only decides which way the
  // speed you already earned is pointing.
  airSteerRate: 4.2,       // radians/second at sprint speed
  // Faster travel turns a wider arc, which is both physically right and what
  // stops a 34 m/s grapple exit from hairpinning. Floored so that even at top
  // speed the player is never a passenger.
  airSteerMinScale: 0.45,

  jumpSpeed: 8.6,
  coyoteTime: 0.12,
  jumpBuffer: 0.14,
  // One mid-air jump, restored on landing or on touching a wall. It reads as
  // the courier's clockwork cape catching air — and mechanically it is a
  // recovery tool: a mistimed gap jump stays survivable, which is what keeps
  // a fast run feeling committed instead of cautious.
  airJumps: 1,
  airJumpSpeed: 7.6,
  // How far a double jump may swing your heading, in radians. This used to be
  // unbounded: the air jump ASSIGNED your full current speed to the steering
  // direction, so tapping A at 20 m/s fired you sideways at 20 m/s. (Ethan:
  // "when you jump off to one side it like transfers your speed all the way to
  // that one side and you just get launched off to the side".) ~50 degrees is
  // enough to feel like a genuine course correction and far short of a
  // right-angle catapult. Expressed as a blend fraction toward the wish
  // heading: 0 keeps your current line exactly, 1 is the old catapult.
  airJumpSteer: 0.5,

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
  // A wall you could simply step onto is a vault, not a climb. This must stay
  // above `vaultMaxHeight` (1.45) or the two systems fight over the same lip.
  //
  // Without the gate the climb won that fight every single time, because the
  // climb *probe* reaches `wallReach` + radius = 0.89 m ahead of the body while
  // the vault only sees contacts the capsule is actually touching — so at
  // 11 m/s the climb fires ~0.05 s before the vault can even be considered.
  // Measured: sprinting into a 0.60 m ledge played a vertical wall-run and
  // threw the player 1.75 m into the air. Every kerb, planter, stair nosing and
  // parapet in the course did that.
  climbMinWallHeight: 1.55,

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
  // Grace before a release can fire — for BOTH of the two "you are done here"
  // tests, the landing one and the arrival one.
  //
  // Landing is the case it was written for (see below). Arrival is the case it
  // was missing, and that omission is Ethan's bug: "sometimes I'll hold down F
  // and it'll like attach to the grapple thing and then immediately detach."
  // `grappleMinRange` (5) and `grappleArriveDist` (3.2) are two independent
  // constants describing the same boundary, so the cuff will happily fire a
  // line that is already 64% of the way to its own exit condition — and whether
  // that exit fires in the same eyeblink depends only on the closing speed the
  // player happened to arrive with. Measured on the shipped build: 4.1% of
  // latches on the skyline course and 5.8% on the void ended within 0.083 s,
  // every single one of them on the arrival test (tools/grapple-probe.mjs).
  //
  // So a latch is now never shorter than this window. Inside the arrival radius
  // the line goes SLACK rather than continuing to pull — holding a player at
  // the anchor by reversing the pull would scrub speed they never asked to lose,
  // which is the one thing this controller may not do. Any shot whose flight is
  // longer than the window (which is every shot the course actually authors)
  // is bit-identical to before, because the window has already run out by the
  // time the anchor arrives.
  //
  // The overwhelmingly common way to use the cuff is to fire it while running
  // along a roof — and the release test includes `this.grounded`, so the shot
  // was cancelled on the very next frame, before the pull had moved anyone. The
  // player saw the reticle light up, pressed F, and nothing happened. 0.25 s is
  // long enough for the pull to get the courier off their feet and far too
  // short to keep the line attached after a genuine landing.
  grappleArmTime: 0.25,
  // Upward pop the moment the line bites, so the pull starts from the air
  // rather than dragging the capsule along the roof it was just standing on.
  grappleLaunch: 2.6,
  // Fraction of gravity that still acts while the line is pulling. Below 1 the
  // pull arcs rather than running on rails; at 0.28 the arc is barely there,
  // which is most of why the cuff currently reads as a flight system.
  grappleGravity: 0.28,
  // How many times the cuff may fire between two touches of ground or wall.
  // Infinite here on purpose: chaining hooks across open air is the FUN-mode
  // fantasy, and it is exactly the thing NORMAL mode takes away.
  grappleAirChain: Infinity,
  // Whether latching refills the dash charge and the air jump. Combined with an
  // unlimited chain this is the second half of free flight — every hook hands
  // back every other airborne verb, so the player never runs out of anything.
  grappleRefreshCharges: 1,
  // May a HELD F re-acquire, or must every shot be a fresh key press?
  //
  // Ethan: "maybe make it more forgiving only in FUN mode", and (docs/intent.md)
  // when in doubt in FUN, keep the player in the air. Holding a grapple button
  // means "grapple" continuously; requiring a re-press means that after any drop
  // the player is holding a dead key and does not know it, which is the same
  // class of complaint as the insta-detach itself.
  //
  // Airborne only, and that restriction is not timidity. Firing off a rooftop
  // while running is the overwhelmingly common use of the cuff (see
  // `grappleArmTime`), and those are presses, which are unaffected. A GROUNDED
  // auto-latch would instead yank a player off the roof they were deliberately
  // running along every time they looked at a lantern with the key still down.
  //
  // This lives in the base table, not in a FUN overlay, so `MODES.fun.tuning`
  // stays provably empty — FUN is today's tuning by construction and there is
  // no second copy of it to drift. NORMAL is the overlay that takes it away,
  // which is the same shape as every other difference between the modes.
  grappleHoldRelatch: 1,

  maxSpeed: 34,
}

/**
 * Difficulty modes.
 *
 * FUN is the empty overlay by construction, so it is *provably* today's
 * tuning — there is no second copy of the numbers to drift out of sync.
 *
 * NORMAL changes only how the grapple behaves, and deliberately leaves
 * `grappleRange` at 34. Range is not a difficulty knob here, it is the level's
 * connectivity graph (docs/course-design.md: "an anchor defines a 34 m sphere
 * of reachable space... placing a brass lantern is what makes a route exist").
 * Shortening it would delete authored crossings rather than make them harder,
 * which is the one thing a difficulty mode must not do. `grapplePull` and
 * `grappleMaxTime` stay put for the same reason: every anchor the level places
 * must still be arrived at.
 *
 * What NORMAL takes away is *repetition*. One hook per launch, no free charges
 * back, real gravity through the pull, no exit multiplier, no re-acquiring on a
 * held key, and a cooldown long enough that you cannot simply turn round and
 * re-hook what you just left. The
 * cuff crosses the gap the designer built it for and then puts you back on your
 * feet — which is the difference between a traversal tool and a flight system.
 * No verb is removed in either mode.
 */
export const MODES = {
  normal: {
    label: 'Normal',
    tuning: {
      grappleGravity: 0.62,
      grappleAirChain: 1,
      grappleRefreshCharges: 0,
      grappleReleaseBoost: 1.0,
      grappleCooldown: 1.4,
      // Every shot is a decision you make with your finger. See
      // `grappleHoldRelatch`: the forgiveness is base behaviour and this is the
      // overlay that removes it, so FUN needs no overlay of its own.
      grappleHoldRelatch: 0,
    },
  },
  fun: {
    label: 'Fun',
    tuning: {},
  },
}

export const DEFAULT_MODE = 'normal'

/** The live tuning table. Mutated in place by `setMode` — see the note there. */
export const TUNING = { ...BASE_TUNING }

let currentMode = DEFAULT_MODE

/**
 * Switch difficulty.
 *
 * `TUNING` is mutated in place rather than replaced because half the codebase
 * holds a live reference to it (camera.js, hud.js, fx/) and captured it at
 * module-eval time. Rebinding the export would leave every one of those readers
 * pointing at the previous mode's numbers — a bug that would show up as the
 * camera and the speed bar disagreeing with the controller, which is far harder
 * to spot than it is to avoid. Assigning the full base first means an overlay
 * key that one mode sets and another does not can never leak across a switch.
 *
 * The caller is responsible for resetting the run: a mode change mid-flight
 * would otherwise leave a player mid-grapple under rules that no longer apply.
 */
export function setMode(name) {
  const mode = MODES[name] ? name : DEFAULT_MODE
  Object.assign(TUNING, BASE_TUNING, MODES[mode].tuning)
  currentMode = mode
  return mode
}

export function getMode() {
  return currentMode
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
    this.grappleArm = 0
    this.grappleCooldown = 0
    this.grappleAnchor = new THREE.Vector3()
    /**
     * The line has delivered you and is no longer pulling.
     *
     * Latched the first time this shot comes inside `grappleArriveDist`, and
     * cleared only on release. A slack line neither pulls nor pushes: the
     * alternative — leaving the pull on once you are past the anchor —
     * decelerates a player who never asked to slow down.
     */
    this.grappleSlack = false
    /** How far the shot was when it bit, and how long it has been live. */
    this.grappleFireDist = 0
    this.grappleHeldTime = 0
    /**
     * Why the line last came off, and every reason so far this session.
     *
     * Ethan: "I want to know when and why grapples disconnect." Every release
     * used to collapse into one undifferentiated `grapplerelease` event, so the
     * only way to answer that question was to guess. The reasons are exhaustive
     * over the shipped code — there is no fifth way for a live line to end:
     *
     *   arrived  inside `grappleArriveDist` once the arm window has run out.
     *            This is the payoff release, and the only one that pays the
     *            exit boost.
     *   letgo    the player released F.
     *   expired  `grappleMaxTime` ran out with the anchor still ahead.
     *   landed   back on the ground after the arm window — the cuff has put
     *            you on your feet.
     *   respawn  the body was teleported out from under the line.
     *
     * Deliberately NOT causes, and worth naming so nobody hunts for them: a
     * min-range violation (min range gates *aiming*, it has never ended a live
     * line), losing line of sight (there is no occlusion test anywhere in the
     * cuff — it latches through geometry by design), running out of chain
     * (`airChainLeft` also gates aiming only), and a mode switch (that resets
     * the run, so it arrives here as `respawn`).
     */
    this.lastRelease = null
    this.releaseTally = { arrived: 0, letgo: 0, expired: 0, landed: 0, respawn: 0 }
    /**
     * Hooks left before the courier has to touch ground or wall again.
     *
     * `Infinity` in FUN, so the counter exists in both modes and the branch
     * that reads it is the same code path in both — a mode that runs different
     * code is a mode that gets a different bug.
     */
    this.airChainLeft = TUNING.grappleAirChain
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
    this._wallHit = { found: false, nx: 0, ny: 0, nz: 0, side: 0, top: -Infinity }
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
    // Highest surface among everything the probe touched. The climb gate needs
    // it to tell a wall from a lip, so the scan can no longer bail on the first
    // match — but it still allocates nothing and still ends after one resolve.
    hit.top = -Infinity

    this._probe.copy(this.position)
    this._probe.x += dx * T.wallReach
    this._probe.z += dz * T.wallReach

    const contacts = this.world.resolve(this._probe, T.radius, this.height, this._scratch)
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i]
      const n = c.normal
      if (Math.abs(n.y) >= 0.45) continue
      // A genuine wall in that direction faces back toward us.
      if (n.x * dx + n.z * dz >= 0) continue
      if (!hit.found) {
        hit.found = true
        hit.nx = n.x; hit.ny = n.y; hit.nz = n.z; hit.side = side
      }
      if (c.top > hit.top) hit.top = c.top
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
    // Every in-flight ability dies with the body. A respawn used to carry the
    // grapple, dash and climb across the cut: fall off the world mid-grapple
    // and you reappeared at the checkpoint still on the line, and were promptly
    // yanked back toward the anchor you had just died under. Cheap to clear,
    // and the alternative is a bug that only shows up on the worst run.
    this._releaseGrapple('respawn')
    this.grappleTimer = 0
    this.grappleArm = 0
    this.dashTimer = 0
    this.climbTimer = 0
    this.airJumpsLeft = TUNING.airJumps
    this.airChainLeft = TUNING.grappleAirChain
    this.grappleCooldown = 0
    this.dashReady = true
    this.coyote = 0
    this.jumpBuffered = 0
    this.footDistance = 0
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

    if (this.dashTimer > 0 || this.grappling) {
      // A dash — and a live grapple line — owns the player's velocity outright.
      // Letting ground friction and the normal accelerate() run during one
      // immediately drags the burst back down to sprint speed, so the ability
      // "fires" but nothing visibly happens, which is exactly what a broken
      // ability looks like from the outside. The grapple belongs here for the
      // same reason plus one of its own: a line fired from a rooftop grazes the
      // roof for a frame or two, and routing those frames to `_groundMove` skips
      // the pull entirely.
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
      // A perfectly straight pull reads as being on rails. How much survives is
      // a mode decision (`grappleGravity`): near-zero is flight, most of it is
      // a swing you have to aim.
      vel.y -= T.gravity * T.grappleGravity * dt
      if (!this.grappleSlack) {
        vel.addScaledVector(this._toAnchor, T.grapplePull * dt)
        return
      }
      // Slack (see `grappleSlack`): no pull, but steering comes back. Freezing
      // the view-to-velocity link for the rest of the grace window would turn
      // the fix for one stutter into a different one, and the exit from a hook
      // is exactly where a player is aiming hardest.
      if (wishing) {
        accelerate(vel, this._wish, T.airWishSpeed, T.airAccel, dt)
        const sp = Math.hypot(vel.x, vel.z)
        const scale = Math.max(
          T.airSteerMinScale,
          Math.min(1, T.sprintSpeed / Math.max(sp, 1)),
        )
        steerHorizontal(vel, this._wish, T.airSteerRate * scale, dt)
      }
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

    if (wishing) {
      // Two independent mechanisms, deliberately kept separate:
      //
      //   accelerate() can only ADD speed along the wish direction, capped at
      //   airWishSpeed. That is the strafe-gain skill ceiling.
      //
      //   steerHorizontal() only ROTATES the speed already there. That is the
      //   steering wheel, and it is what makes a jump feel controllable rather
      //   than committed.
      //
      // Keeping them apart means adding steering cannot accidentally become a
      // speed exploit: no amount of wiggling the stick creates velocity.
      accelerate(vel, this._wish, T.airWishSpeed, T.airAccel, dt)

      // Wall-running has its own along-wall steering and must not be fought.
      if (!this.wallRunning) {
        const speed = Math.hypot(vel.x, vel.z)
        const scale = Math.max(
          T.airSteerMinScale,
          Math.min(1, T.sprintSpeed / Math.max(speed, 1)),
        )
        steerHorizontal(vel, this._wish, T.airSteerRate * scale, dt)
      }
    }
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

    // The chain budget gates *aiming*, not just firing, so the reticle and the
    // HOOK lamp go dark the moment the cuff is spent. An ability that silently
    // does nothing is indistinguishable from one that is broken — that is a
    // lesson this HUD already paid for once with the dash charge.
    this.aimedAnchor = (this.grappleCooldown <= 0 && !this.grappling && this.airChainLeft > 0)
      ? this._findAnchor()
      : null

    if (this.grappling) {
      this.grappleTimer -= dt
      this.grappleArm = Math.max(0, this.grappleArm - dt)
      this.grappleHeldTime += dt
      const dist = this.position.distanceTo(this.grappleAnchor)
      // Reaching the arrival radius makes the line slack, permanently for this
      // shot. Latched rather than re-tested every step on purpose: a player who
      // sails through the radius at 30 m/s is OUT of it again a step later, and
      // a pull that switched back on there would be hauling them backwards —
      // deceleration nobody asked for, which is the one thing forbidden here.
      if (dist < T.grappleArriveDist) this.grappleSlack = true
      const arrived = this.grappleSlack

      // Release on: arriving, letting go, running out of line, or landing.
      // Both of the "you are done here" tests wait out `grappleArmTime`; see
      // the note on that constant for why each of them needs it.
      const landed = this.grounded && this.grappleArm <= 0
      let reason = null
      if (arrived && this.grappleArm <= 0) reason = 'arrived'
      else if (!input.grappleHeld) reason = 'letgo'
      else if (this.grappleTimer <= 0) reason = 'expired'
      else if (landed) reason = 'landed'
      if (reason) this._releaseGrapple(reason, dist, arrived)
    } else if (this.aimedAnchor && (input.grapplePressed ||
               (T.grappleHoldRelatch && input.grappleHeld && !this.grounded))) {
      this.grappling = true
      this.grappleSlack = false
      this.grappleTimer = T.grappleMaxTime
      this.grappleArm = T.grappleArmTime
      this.grappleHeldTime = 0
      this.grappleFireDist = this.position.distanceTo(this.aimedAnchor)
      this.grappleAnchor.copy(this.aimedAnchor)
      this.grappleCooldown = T.grappleCooldown
      // Spend a link of the chain. In FUN this is Infinity and stays Infinity.
      this.airChainLeft--
      if (T.grappleRefreshCharges) {
        this.dashReady = true        // latching on refreshes the dash
        this.airJumpsLeft = T.airJumps
      }
      // The cuff yanks you off the roof. Without this the capsule stayed in
      // ground contact, took `_groundMove` instead of the pull, and the shot
      // read as a dead button.
      this.grounded = false
      if (this.velocity.y < T.grappleLaunch) this.velocity.y = T.grappleLaunch
      // The climb branch in `_airMove` runs ahead of the grapple branch and
      // returns, so a line fired off a wall you are already running up would
      // otherwise be swallowed until the climb timed out.
      this.climbTimer = 0
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
    // gets to use it repeatedly and a flailing one does not. They restore the
    // grapple's chain budget on the same rule. That
    // is the whole shape of NORMAL mode: the cuff is not rationed, it is *paid
    // for with contact*. Cross the gap, land it, and the cuff is yours again —
    // so the parkour between the hooks is the thing you have to actually do.
    if (this.grounded || this.wallRunning) {
      this.dashReady = true
      this.airJumpsLeft = T.airJumps
      this.airChainLeft = T.grappleAirChain
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
      // Steering into the second jump redirects it — but only PART of the way.
      //
      // This used to assign the full current speed to the wish direction,
      // which meant a double jump was a right-angle catapult: carrying 20 m/s
      // forward and tapping A launched you sideways at 20 m/s, off the course.
      // Now it swings the heading by at most `airJumpSteer` and preserves the
      // magnitude, so it reads as a course correction rather than a slingshot.
      if (this._wish.lengthSq() > 1e-6) {
        steerFraction(this.velocity, this._wish, T.airJumpSteer)
        // Standing starts still get a nudge, so a double jump from rest is not
        // a purely vertical hop.
        const s = this.speed
        if (s < T.walkSpeed) {
          this.velocity.x = this._wish.x * T.walkSpeed
          this.velocity.z = this._wish.z * T.walkSpeed
        }
      }
      this.events.push({ type: 'airjump', speed: this.speed })
    }
  }

  /**
   * Is there floor close enough below that we will certainly land within
   * `time` seconds at the current fall rate?
   *
   * Only called on the handful of frames where a jump is buffered mid-air, and
   * it borrows the shared probe/scratch, so it allocates nothing.
   *
   * The prediction is the real ballistic one — `-vy·t + ½g·t²` — and it probes
   * where the player will *be*, carrying their horizontal velocity across the
   * interval. The previous version used `-vy·t·0.75` at the current x/z: a flat
   * pessimism factor standing in for the "player drifts off the ledge we just
   * probed" case. It got that case wrong in both directions. Measured: pressing
   * jump 0.133 s before touchdown from a 4 m fall under-predicted the remaining
   * drop by 0.5 m, found no floor, and spent the air jump at knee height for a
   * *weaker* hop (7.6 vs 8.6) — the precise failure this guard exists to
   * prevent. Advancing the probe horizontally answers the drift case properly
   * rather than by fudge, so the pessimism is gone.
   *
   * It walks down the arc instead of probing only its end, because a single
   * deep probe punches clean through a thick slab: the capsule axis lands
   * *inside* the box, the minimum-translation escape comes back pointing down,
   * and the floor the player is a hand's breadth above reads as no floor at
   * all. That regression cost the air jump on a press 0.03 s before touchdown —
   * the opposite end of the same window the ballistic fix was widening.
   */
  _floorWithinFall(time) {
    const T = TUNING
    const fall = -this.velocity.y * time + 0.5 * T.gravity * time * time
    if (fall < 0.02) return false
    // One sample per half metre. The probe capsule is 1.75 m tall, so this is
    // heavily redundant on purpose — it runs on the handful of frames where a
    // jump is buffered mid-fall, and being sure beats being cheap there.
    const steps = fall < 0.5 ? 1 : Math.min(6, Math.ceil(fall / 0.5))
    for (let s = 1; s <= steps; s++) {
      const f = s / steps
      this._probe.copy(this.position)
      this._probe.x += this.velocity.x * time * f
      this._probe.z += this.velocity.z * time * f
      this._probe.y -= fall * f
      const below = this.world.resolve(this._probe, T.radius, this.height, this._scratch)
      for (let i = 0; i < below.length; i++) {
        if (below[i].normal.y > 0.7) return true
      }
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

          const vyBefore = vel.y
          const vn = vel.dot(n)
          if (vn < 0) vel.addScaledVector(n, -vn)

          // A step-up edge must never *manufacture* upward velocity.
          //
          // The capsule's bottom hemisphere does not meet a low ledge's
          // vertical face; it meets the top edge, and the normal from the
          // capsule axis to that edge comes back tilted around n.y ≈ 0.5.
          // Cancelling velocity along that tilted normal converts horizontal
          // momentum straight into vertical: measured, an 11 m/s sprint into a
          // 0.20 m kerb came out at +4.7 m/s upward and 0.67 m off the deck,
          // and an eight-step staircase launched the player at 10.6 m/s —
          // harder than the jump button (8.6). The player never pressed
          // anything, which makes it a bug by the rule at the top of this file,
          // and because it flings them airborne the vault path never runs, so
          // the camera gets no `stepUp` to smooth and the move reads as
          // tripping rather than as a mantle.
          //
          // The clamp is deliberately one-sided: the impulse may still *arrest*
          // a fall (that is a real landing), it may not turn one into a climb.
          // Same shape as the grounded step-up rule in `_resolveTransitions`.
          if (n.y > 0.05 && n.y <= 0.7) {
            const ceiling = vyBefore > 0 ? vyBefore : 0
            if (vel.y > ceiling) vel.y = ceiling
          }

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

    // A lip you could simply step onto is a vault. See `climbMinWallHeight`:
    // the climb probe outranges the vault, so without this gate the vertical
    // wall-run stole every kerb and ledge in the course.
    if (hit.top - this.position.y < T.climbMinWallHeight) return false

    // Steering must be squarely into the wall, not sliding along it — that
    // case is a lateral wall-run and is handled separately.
    if (-(this._wish.x * hit.nx + this._wish.z * hit.nz) < 0.5) return false

    this.climbTimer = T.climbTime
    this.wallNormal.set(hit.nx, hit.ny, hit.nz).normalize()
    this.wallSide = 0
    this.grounded = false
    this.dashReady = true
    // A vertical wall-run is contact, so it pays for the cuff like a landing
    // does. Without this, a grapple into a wall-climb — the exact combination
    // docs/course-design.md asks the middle of the course to demand — would
    // dead-end in NORMAL for no reason the player could see.
    this.airChainLeft = TUNING.grappleAirChain
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
   *
   * `reason` is one of the five enumerated on `lastRelease`, and it rides out
   * on the event so that "when and why do grapples disconnect" is answerable
   * from a tally rather than from a guess. `arrived` is carried separately
   * because it decides the PAYOUT, not the cause: letting go of F on the last
   * metre still counts as an arrival and still pays the boost, exactly as it
   * did before the reasons existed.
   */
  _releaseGrapple(reason, dist = 0, arrived = false) {
    if (!this.grappling) return
    this.grappling = false
    this.grappleSlack = false
    this.grappleTimer = 0
    if (arrived) {
      this.velocity.multiplyScalar(TUNING.grappleReleaseBoost)
      // A little lift on arrival so you clear the anchor you just flew at
      // instead of clipping its underside.
      this.velocity.y = Math.max(this.velocity.y, 3.2)
    }
    this.releaseTally[reason] = (this.releaseTally[reason] || 0) + 1
    const info = {
      type: 'grapplerelease',
      reason,
      arrived,
      speed: this.speed,
      dist,                                // metres to the anchor at release
      fireDist: this.grappleFireDist,      // metres to it when the line bit
      held: this.grappleHeldTime,          // seconds the line was live
    }
    this.lastRelease = info
    this.events.push(info)
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

/**
 * Blend horizontal heading toward `dir` by an explicit fraction, preserving
 * magnitude. Used where the turn is a single discrete event rather than a
 * continuous rate — a double jump's course correction, specifically.
 */
function steerFraction(vel, dir, k) {
  const sp = Math.hypot(vel.x, vel.z)
  if (sp < 1e-4) return
  const cx = vel.x / sp, cz = vel.z / sp
  const nx = cx + (dir.x - cx) * k
  const nz = cz + (dir.z - cz) * k
  const l = Math.hypot(nx, nz)
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
