import * as THREE from 'three'
import { TUNING } from './player.js'

/**
 * The camera *is* the character.
 *
 * With no visible body, every bit of physicality has to arrive through the
 * lens: the field of view opening up as speed builds, the roll into a
 * wall-run, weight landing on the legs, the rhythm of a stride. All of it is
 * spring-damped rather than keyframed, so it responds to whatever the player
 * actually did instead of playing a canned animation at them.
 *
 * The rig's other job is quieter and just as important: the body teleports.
 * A mantle moves it up to 1.45 m in one frame, a slide drops the eye 0.80 m,
 * standing back up raises it again. Followed literally, every one of those is
 * a cut. Everything below the "vertical smoothing" heading exists to turn
 * those cuts into movement.
 *
 * Restraint is the rule here (docs/taste.md): motion sickness is a failure
 * state, so every amplitude below is deliberately smaller than it wants to be.
 */

// FOV budget is deliberately tight. The earlier values peaked around 95°,
// which fisheyes the frame, bends straight architecture at the edges, and
// reads as the camera zooming rather than the player accelerating.
const BASE_FOV = 74
const SPEED_FOV = 8          // added across the walk→sprint band
// A second, gentler band above the sprint cap. Without it the FOV saturated at
// 11 m/s, so a dash (21), a grapple exit (34) and a plain jog-sprint all
// produced exactly the same frame — the three fastest things in the game were
// invisible. This is a *sustained speed* cue, never an event cue: it is driven
// only by how fast the player is actually travelling, so it ramps in over a
// third of a second rather than punching.
const BOOST_FOV = 4
const BOOST_SPEED = 24
const WALLRUN_FOV = 3
const MAX_PITCH = Math.PI / 2 - 0.02

// --- turn lean ---------------------------------------------------------
// Banking into a carve is how a racing game says "you are carrying speed
// through this corner", and it is the one physical cue a bodiless first-person
// camera has for a turn — the strafe lean below only fires on A/D, so a player
// steering with the mouse, which is how anyone actually corners here, got
// nothing at all. Deliberately near the threshold of perception: the cap is
// 1.5°, roughly a tenth of the wall-run roll, and it is low-passed so a flick
// of the wrist cannot snap the horizon. Motion sickness is a failure state
// (docs/taste.md), and a camera that rolls on every mouse movement is the
// classic way to induce it.
const TURN_LEAN = 0.009      // radians of roll per rad/s of yaw
const TURN_LEAN_MAX = 0.026
const TURN_SMOOTH = 11       // rad/s low-pass on the measured yaw rate

// Vertical smoothing spring, kept critically damped (c = 2ω) at every
// amplitude: no overshoot, because an overshooting camera on a staircase is
// nausea. At the base 16 rad/s it settles in about 0.25 s, so a single mantle
// is absorbed softly and the view never feels detached from the body.
const STEP_OMEGA = 16
// ...but the frequency rises with how far the eye is trailing. A staircase
// taken at sprint injects a step every ~0.05 s, far faster than a 0.25 s
// settle, so the offsets stack: an eight-step flight measured 0.80 m of trail
// against a 0.90 m clamp, and anything longer pins the view at chest height
// until the stairs run out. Scaling ω up to 2.1x as the offset approaches the
// clamp pulls a deep trail back inside ~0.12 s while leaving small step-ups
// exactly as soft as they were.
const STEP_OMEGA_GAIN = 1.1
// Bail-out for absurd accumulations. A respawn does not reach here at all —
// it moves the body without changing stance or reporting a step-up, so nothing
// is injected and the view simply cuts with it, which is what a respawn should
// do. This catches the pathological stack instead: mantling the full
// `vaultMaxHeight` (1.45 m) out of a stance change (0.80 m) while the eye is
// already trailing by STEP_MAX. Smoothing that would drop the view to the
// player's knees; cutting is the lesser evil.
const STEP_TELEPORT = 3.0
const STEP_MAX = 0.9         // never let the eye trail the body by more than this

// --- wall contact ------------------------------------------------------
// Falling *next to* a wall and running *on* one produced identical frames
// unless the wall happened to be to one side (the roll below only fires on a
// lateral run, and a climb actively damps it — a head-on climb has no side to
// lean toward). So contact gets its own channel: a texture the surface writes
// onto the lens for exactly as long as a boot is on it.
//
// It rides the shake maths but is NOT `this.shake` — main.js assigns that from
// the speed FX every frame, so anything written there is overwritten before it
// is used. This is derived from player state inside `update` instead, which
// also means it needs no reset path: off a wall it decays to nothing on its
// own within about a third of a second.
//
// 0.0017 rad is 0.10°, roughly a sixth of the peak of the existing shake.
// Deliberately at the bottom of what registers — this has to read as the wall
// being there, never as the camera being hit.
const CONTACT_SHAKE = 0.0017
// Two rates off one channel, which is the point: a climb is boots scrabbling
// for purchase and a lateral run is a surface sliding past. They must not feel
// the same, because telling them apart is the whole problem.
const CONTACT_HZ_CLIMB = 74
const CONTACT_HZ_RUN = 39
const CONTACT_RUN_AMP = 0.34

export const DEFAULT_MOUSE_SENSITIVITY = 0.0021

export class CameraRig {
  constructor(camera) {
    this.camera = camera
    this.yaw = 0
    this.pitch = 0
    this.sensitivity = DEFAULT_MOUSE_SENSITIVITY

    this.roll = 0
    this.rollVel = 0
    this.dip = 0
    this.dipVel = 0
    this.fov = BASE_FOV
    this.shake = 0
    this.shakeTime = 0
    this.contact = 0
    this.contactTime = 0
    this.slideEase = 0
    this.stepOffset = 0
    this.stepVel = 0
    this.prevEyeHeight = null
    this.bobPhase = 0
    this.bobAmp = 0
    this.prevYaw = null
    this.turnRate = 0
    this.footParity = 1
    this.bob = new THREE.Vector3()

    camera.rotation.order = 'YXZ'
    camera.fov = BASE_FOV
    camera.updateProjectionMatrix()
  }

  look(dx, dy) {
    this.yaw -= dx * this.sensitivity
    this.pitch -= dy * this.sensitivity
    if (this.pitch > MAX_PITCH) this.pitch = MAX_PITCH
    if (this.pitch < -MAX_PITCH) this.pitch = -MAX_PITCH
  }

  update(dt, player, input) {
    // Fixed-ish step keeps the springs stable if a frame hitches.
    const h = Math.min(dt, 1 / 30)

    // Indexed rather than for..of: this runs every frame, and the iterator
    // protocol allocates an object per loop for no benefit here.
    for (let i = 0; i < player.events.length; i++) {
      const e = player.events[i]
      if (e.type === 'land') this.dipVel -= e.impact * 5.5
      else if (e.type === 'vault') this.dipVel -= 1.4
      else if (e.type === 'walljump') this.dipVel -= 0.8
      else if (e.type === 'climb') this.dipVel -= 0.9
      // The air jump gets an upward lift instead of a dip — the cape catches
      // and pulls you up, so the camera should rise into it, not compress.
      else if (e.type === 'airjump') this.dipVel += 2.6
      // The cuff bites and yanks. Small: the speed band is already doing the
      // heavy lifting for how a grapple reads.
      else if (e.type === 'grapple') this.dipVel += 1.3
    }
    // NOTE: impulse events deliberately do NOT touch the field of view.
    //
    // Punching the FOV on an instantaneous event warps the entire frame for a
    // tenth of a second, which reads as the view lurching rather than as the
    // player accelerating — and it is genuinely unpleasant on a double jump,
    // where nothing about the world has changed scale. FOV is reserved for
    // sustained speed. That includes the dash, which used to get a flat +3 for
    // its 0.22 s: that was an event punch wearing a state's clothes. The dash's
    // speed now shows up through the boost band on its own, and keeps showing
    // up for as long as the player actually carries it.

    // --- landing dip: critically-ish damped spring ----------------------
    this.dipVel += (-this.dip * 90 - this.dipVel * 13) * h
    this.dip += this.dipVel * h
    if (this.dip < -0.42) { this.dip = -0.42; this.dipVel = 0 }

    // --- vertical smoothing ---------------------------------------------
    // Two sources of instantaneous eye movement, both absorbed the same way:
    // push the offset the other way, then spring it back to zero.
    //
    //  1. Stance. `player.height` snaps between standing and sliding, so the
    //     eye jumped 0.80 m down entering a slide and 0.85 m back up leaving
    //     one, in a single frame, every time. (Measured; the `slideEase`
    //     spring below only ever drove roll.)
    //  2. Step-ups and mantles, reported exactly by `player.stepUp`.
    const eyeHeight = player.eyeHeight
    if (this.prevEyeHeight !== null) this.stepOffset -= eyeHeight - this.prevEyeHeight
    this.prevEyeHeight = eyeHeight
    this.stepOffset -= player.stepUp

    if (Math.abs(this.stepOffset) > STEP_TELEPORT) {
      this.stepOffset = 0
      this.stepVel = 0
    } else if (this.stepOffset < -STEP_MAX) this.stepOffset = -STEP_MAX
    else if (this.stepOffset > STEP_MAX) this.stepOffset = STEP_MAX

    // Squared so the stiffening stays out of the way until the trail is
    // genuinely deep — a lone 0.2 m kerb barely moves it.
    const trail = Math.min(1, Math.abs(this.stepOffset) / STEP_MAX)
    const omega = STEP_OMEGA * (1 + STEP_OMEGA_GAIN * trail * trail)
    // Damping solved implicitly. Explicit Euler on a spring is only stable
    // while 2ωh < 2, and at the stiff end this one reaches ω = 33.6 against the
    // h = 1/30 s ceiling — 2ωh = 2.24, which diverges. That is a bug you would
    // never see on the machine you tuned it on and which throws the view around
    // on a 30 fps machine, so it gets the unconditionally-stable form rather
    // than a comment promising nobody will stiffen it further.
    this.stepVel = (this.stepVel - this.stepOffset * omega * omega * h) / (1 + 2 * omega * h)
    this.stepOffset += this.stepVel * h

    // --- slide: the camera tilts and leans into the direction -------------
    // The drop itself is handled above; this is the bank that makes the ground
    // rushing past read as speed rather than as a shorter player.
    const slideT = player.sliding ? 1 : 0
    this.slideEase += (slideT - this.slideEase) * (1 - Math.exp(-(slideT > this.slideEase ? 16 : 7) * h))

    // --- how fast, as a 0..1 across the walk→sprint band ------------------
    // Shared by the turn lean and the field of view so the two cues agree
    // about when the player counts as "moving fast".
    const speedT = clamp01((player.speed - TUNING.walkSpeed) / (TUNING.sprintSpeed - TUNING.walkSpeed))

    // --- turn rate, measured from the yaw the player actually produced -----
    // Differentiated here rather than accumulated in `look()` because look()
    // fires per mouse event, several times a frame or not at all, and a rate
    // built from that is a rate built from the mouse's polling interval.
    //
    // The `h > 0` guard is not defensive padding. main.js reads the clock
    // immediately before its first frame, so that frame's dt is 0 — and
    // performance.now() is coarse enough in a hardened browser that it recurs.
    // `0 / 0` is NaN, NaN poisons turnRate, turnRate poisons rollTarget, and
    // roll is a spring, so it never recovers: measured, one zero-length frame
    // at boot silently killed the wall-run lean, the strafe lean and the slide
    // bank for the entire session. A zero-length frame contains no turn.
    if (this.prevYaw === null) {
      this.prevYaw = this.yaw
    } else if (h > 1e-6) {
      let dYaw = this.yaw - this.prevYaw
      // A respawn assigns yaw outright. That is a cut, not a turn; leaning into
      // it would bank the camera on every reset.
      if (Math.abs(dYaw) > 0.5) dYaw = 0
      this.prevYaw = this.yaw
      this.turnRate += (dYaw / h - this.turnRate) * (1 - Math.exp(-TURN_SMOOTH * h))
    }

    // --- roll: wall-run lean, plus a whisper of strafe and turn lean ------
    let rollTarget = player.wallRunning ? player.wallSide * 0.155 : 0
    rollTarget += -input.right * 0.018
    // Same sign convention as the strafe lean: steering right banks right.
    // Scaled by speed, so walking around a corner does not tilt the world.
    rollTarget += clampAbs(this.turnRate * TURN_LEAN, TURN_LEAN_MAX) * speedT
    rollTarget += this.slideEase * (0.055 + input.right * -0.05)
    if (player.climbTimer > 0) rollTarget *= 0.2
    this.rollVel += ((rollTarget - this.roll) * 120 - this.rollVel * 16) * h
    this.roll += this.rollVel * h

    // --- wall contact: how a surface feels through a boot -----------------
    // Attack is fast because contact is an impact; release is slow so the last
    // frame of a wall does not click off, and so the coyote window still feels
    // like a wall for as long as it still behaves like one.
    const climbing = player.climbTimer > 0
    const contactTarget = climbing ? 1 : player.wallRunning ? CONTACT_RUN_AMP : 0
    const contactRate = contactTarget > this.contact ? 26 : 8
    this.contact += (contactTarget - this.contact) * (1 - Math.exp(-contactRate * h))
    this.contactTime += h * (climbing ? CONTACT_HZ_CLIMB : CONTACT_HZ_RUN)

    // --- field of view: the primary speed cue ----------------------------
    const boost = clamp01((player.speed - TUNING.sprintSpeed) / (BOOST_SPEED - TUNING.sprintSpeed))
    let fovTarget = BASE_FOV + speedT * SPEED_FOV + boost * BOOST_FOV
    if (player.wallRunning) fovTarget += WALLRUN_FOV
    if (player.sliding) fovTarget += 2
    if (player.climbTimer > 0) fovTarget += 3
    // Opens faster than it closes. Speed arriving should be felt; speed leaving
    // should not snap the frame back the instant you clip a corner.
    const fovRate = fovTarget > this.fov ? 5 : 3.5
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-fovRate * h))

    // --- head bob: rhythm, not decoration --------------------------------
    // Phase comes from the same footDistance/stride the player uses to fire
    // 'step' events, so the bottom of the bob lands on the footstep sound. The
    // rig used to integrate its own phase from raw speed, which ran the visual
    // rhythm at 2.6 Hz over audio firing at 4.3 Hz — both halves individually
    // fine, and together reading as broken.
    const stride = input.sprint ? TUNING.strideSprint : TUNING.strideWalk
    const moving = player.grounded && !player.sliding && player.speed > 0.6
    // Amplitude is eased rather than switched, so landing does not pop the bob
    // on at full size mid-stride.
    const ampTarget = moving ? Math.min(0.055, 0.006 * player.speed) : 0
    this.bobAmp += (ampTarget - this.bobAmp) * (1 - Math.exp(-9 * h))

    // Modulo, not a running sum: sliding parks footDistance against a huge
    // stride and it would otherwise come back as a meaningless large number.
    const phase = (player.footDistance / stride) % 1
    if (phase < this.bobPhase) this.footParity = -this.footParity   // a footfall
    this.bobPhase = phase
    const rise = Math.sin(Math.PI * phase)
    // Vertical is centred on the eye line so the average height does not creep
    // upward with speed. Lateral alternates per footfall — hence the parity —
    // and is zero at both ends of the stride, which is what keeps it smooth
    // across the wrap.
    this.bob.set(
      rise * this.bobAmp * 0.55 * this.footParity,
      (rise * rise - 0.5) * this.bobAmp,
      0,
    )

    // --- shake: high-frequency, tiny amplitude, always decaying ----------
    // Shake is applied to the *rotation*, never the position — translating
    // the camera at speed reads as a physics glitch, while rotating it reads
    // as the world hitting you.
    this.shakeTime += h * 47
    const sh = this.shake * 0.010
    const shakeX = Math.sin(this.shakeTime) * Math.sin(this.shakeTime * 0.37) * sh
    const shakeY = Math.cos(this.shakeTime * 1.13) * sh
    const shakeZ = Math.sin(this.shakeTime * 0.71) * sh * 1.4

    // Same channel, same rule: rotation only, never position. Weighted toward
    // roll rather than pitch, because a judder in the horizon reads as a
    // surface being dragged along and a judder in the pitch reads as a hit.
    const con = this.contact * CONTACT_SHAKE
    const conX = Math.sin(this.contactTime * 1.7) * con * 0.7
    const conZ = Math.sin(this.contactTime) * Math.sin(this.contactTime * 0.31) * con * 1.6

    // --- commit ----------------------------------------------------------
    const cam = this.camera
    const bobWorldX = Math.cos(this.yaw) * this.bob.x
    const bobWorldZ = -Math.sin(this.yaw) * this.bob.x
    cam.position.set(
      player.position.x + bobWorldX,
      player.position.y + eyeHeight + this.stepOffset + this.dip + this.bob.y,
      player.position.z + bobWorldZ,
    )
    cam.rotation.set(this.pitch + shakeX + conX, this.yaw + shakeY, this.roll + shakeZ + conZ)

    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function clampAbs(v, limit) {
  return v < -limit ? -limit : v > limit ? limit : v
}
