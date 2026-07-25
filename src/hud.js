import { TUNING } from './player.js'

/**
 * The HUD is deliberately thin.
 *
 * Everything here reports state the player already caused; nothing here
 * explains how to play. A brass wall teaches wall-running by being brass and
 * being in the way, not by a floating label. The one exception is the verb
 * readout, which names the state you are already in so the vocabulary becomes
 * learnable without a tutorial.
 */

const $ = (id) => document.getElementById(id)

export class Hud {
  constructor() {
    this.timer = $('timer')
    this.splits = $('splits')
    this.speedval = $('speedval')
    this.speedfill = $('speedfill')
    this.verb = $('verb')
    this.reticle = $('reticle')
    this.toast = $('toast')
    this.toastBig = this.toast.querySelector('.big')
    this.toastSub = this.toast.querySelector('.sub')
    this.overlay = $('overlay')

    this._toastUntil = 0
    this._lastVerb = ''
  }

  setOverlay(visible) {
    this.overlay.classList.toggle('hidden', !visible)
  }

  update(now, { time, player, checkpointsHit, checkpointsTotal, finished }) {
    this.timer.textContent = formatTime(time)
    this.splits.textContent = finished
      ? 'route complete'
      : `checkpoint ${checkpointsHit} / ${checkpointsTotal}`

    // km/h reads more legibly than m/s at a glance, and makes the difference
    // between a good line and a lazy one feel like it matters.
    const kmh = player.speed3d * 3.6
    this.speedval.innerHTML = `${Math.round(kmh)}<small>KM/H</small>`
    const frac = Math.min(1, player.speed / (TUNING.maxSpeed * 0.8))
    this.speedfill.style.width = `${frac * 100}%`
    // The bar goes warm once you are past sprint speed — the visual signal
    // that you are now carrying momentum rather than merely running.
    const hot = player.speed > TUNING.sprintSpeed
    this.speedfill.style.background = hot ? '#f0e4cf' : '#d9a441'
    this.reticle.classList.toggle('hot', player.wallRunning)

    const verb = currentVerb(player)
    if (verb !== this._lastVerb) {
      this._lastVerb = verb
      this.verb.textContent = verb
      this.verb.classList.toggle('on', verb !== '')
    }

    if (this._toastUntil && now > this._toastUntil) {
      this._toastUntil = 0
      this.toast.classList.remove('on')
    }
  }

  showToast(big, sub, now, duration = 2.2) {
    this.toastBig.textContent = big
    this.toastSub.textContent = sub
    this.toast.classList.add('on')
    this._toastUntil = now + duration
  }

  holdToast(big, sub) {
    this.toastBig.textContent = big
    this.toastSub.textContent = sub
    this.toast.classList.add('on')
    this._toastUntil = 0
  }
}

function currentVerb(p) {
  if (p.climbTimer > 0) return 'climb'
  if (p.dashTimer > 0) return 'dash'
  if (p.wallRunning) return 'wall-run'
  if (p.sliding) return 'slide'
  if (!p.grounded) return ''
  if (p.speed > TUNING.walkSpeed + 0.4) return 'sprint'
  return ''
}

export function formatTime(t) {
  if (t < 60) return t.toFixed(2)
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`
}
