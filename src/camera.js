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

// Vertical smoothing spring. ~critically damped at omega 16 rad/s: no
// overshoot (an overshooting camera on a staircase is nausea), and it is done
// inside about 0.25 s so the view never feels detached from the body.
const STEP_K = 256
const STEP_C = 32
// Bail-out for absurd accumulations. A respawn does not reach here at all —
// it moves the body without changing stance or reporting a step-up, so nothing
// is injected and the view simply cuts with it, which is what a respawn should
// do. This catches the pathological stack instead: mantling the full
// `vaultMaxHeight` (1.45 m) out of a stance change (0.80 m) while the eye is
// already trailing by STEP_MAX. Smoothing that would drop the view to the
// player's knees; cutting is the lesser evil.
const STEP_TELEPORT = 3.0
const STEP_MAX = 0.9         // never let the eye trail the body by more than this

export class CameraRig {
  constructor(camera) {
    this.camera = camera
    this.yaw = 0
    this.pitch = 0
    this.sensitivity = 0.0021

    this.roll = 0
    this.rollVel = 0
    this.dip = 0
    this.dipVel = 0
    this.fov = BASE_FOV
    this.shake = 0
    this.shakeTime = 0
    this.slideEase = 0
    this.stepOffset = 0
    this.stepVel = 0
    this.prevEyeHeight = null
    this.bobPhase = 0
    this.bobAmp = 0
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

    this.stepVel += (-this.stepOffset * STEP_K - this.stepVel * STEP_C) * h
    this.stepOffset += this.stepVel * h

    // --- slide: the camera tilts and leans into the direction -------------
    // The drop itself is handled above; this is the bank that makes the ground
    // rushing past read as speed rather than as a shorter player.
    const slideT = player.sliding ? 1 : 0
    this.slideEase += (slideT - this.slideEase) * (1 - Math.exp(-(slideT > this.slideEase ? 16 : 7) * h))

    // --- roll: wall-run lean, plus a whisper of strafe lean --------------
    let rollTarget = player.wallRunning ? player.wallSide * 0.155 : 0
    rollTarget += -input.right * 0.018
    rollTarget += this.slideEase * (0.055 + input.right * -0.05)
    if (player.climbTimer > 0) rollTarget *= 0.2
    this.rollVel += ((rollTarget - this.roll) * 120 - this.rollVel * 16) * h
    this.roll += this.rollVel * h

    // --- field of view: the primary speed cue ----------------------------
    const t = clamp01((player.speed - TUNING.walkSpeed) / (TUNING.sprintSpeed - TUNING.walkSpeed))
    const boost = clamp01((player.speed - TUNING.sprintSpeed) / (BOOST_SPEED - TUNING.sprintSpeed))
    let fovTarget = BASE_FOV + t * SPEED_FOV + boost * BOOST_FOV
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

    // --- commit ----------------------------------------------------------
    const cam = this.camera
    const bobWorldX = Math.cos(this.yaw) * this.bob.x
    const bobWorldZ = -Math.sin(this.yaw) * this.bob.x
    cam.position.set(
      player.position.x + bobWorldX,
      player.position.y + eyeHeight + this.stepOffset + this.dip + this.bob.y,
      player.position.z + bobWorldZ,
    )
    cam.rotation.set(this.pitch + shakeX, this.yaw + shakeY, this.roll + shakeZ)

    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
