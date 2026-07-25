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
 * Restraint is the rule here (docs/taste.md): motion sickness is a failure
 * state, so every amplitude below is deliberately smaller than it wants to be.
 */

const BASE_FOV = 76
const SPEED_FOV = 15         // added across the walk→sprint band
const WALLRUN_FOV = 5
const MAX_PITCH = Math.PI / 2 - 0.02

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
    this.kick = 0
    this.shake = 0
    this.shakeTime = 0
    this.slideEase = 0
    this.bobPhase = 0
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

    for (const e of player.events) {
      if (e.type === 'land') this.dipVel -= e.impact * 5.5
      else if (e.type === 'vault') this.dipVel -= 1.4
      else if (e.type === 'walljump') this.dipVel -= 0.8
      else if (e.type === 'dash') this.kick = 1
      else if (e.type === 'climb') this.dipVel -= 0.9
      // The air jump gets an upward lift instead of a dip — the cape catches
      // and pulls you up, so the camera should rise into it, not compress.
      else if (e.type === 'airjump') { this.dipVel += 2.6; this.kick = 0.55 }
    }
    // Dash punches the FOV out and lets it fall back — the burst has to be
    // felt, not just measured on the speed readout.
    this.kick *= Math.exp(-6 * h)

    // --- landing dip: critically-ish damped spring ----------------------
    this.dipVel += (-this.dip * 90 - this.dipVel * 13) * h
    this.dip += this.dipVel * h
    if (this.dip < -0.42) { this.dip = -0.42; this.dipVel = 0 }

    // --- slide: the camera drops, tilts, and leans into the direction -----
    // Sliding has no animation to sell it, so the pose does all the work: get
    // low fast, ease back up slowly, and hold a bank so the ground rushing
    // past reads as speed rather than as a shorter player.
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
    let fovTarget = BASE_FOV + t * SPEED_FOV
    if (player.wallRunning) fovTarget += WALLRUN_FOV
    if (player.sliding) fovTarget += 4
    if (player.climbTimer > 0) fovTarget += 6
    this.fov += (fovTarget - this.fov) * (1 - Math.exp(-7 * h))
    // The dash kick is added *after* the smoothing so it lands on the frame
    // it happens rather than easing in a tenth of a second late.
    this.fov += this.kick * 9

    // --- head bob: rhythm, not decoration --------------------------------
    if (player.grounded && !player.sliding && player.speed > 0.6) {
      this.bobPhase += player.speed * h * 1.5
      const amp = Math.min(0.055, 0.006 * player.speed)
      this.bob.set(Math.cos(this.bobPhase) * amp * 0.55, Math.abs(Math.sin(this.bobPhase)) * amp, 0)
    } else {
      this.bob.multiplyScalar(1 - Math.min(1, 9 * h))
    }

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
      player.position.y + player.eyeHeight + this.dip + this.bob.y,
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
