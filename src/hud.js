import { TUNING } from './player.js'

/**
 * The HUD is instrumentation, not a tutorial.
 *
 * Everything here reports state the player already caused; nothing here
 * explains how to play. A brass wall teaches wall-running by being brass and
 * being in the way, not by a floating label. The two exceptions are the verb
 * readout, which names the state you are already in so the vocabulary becomes
 * learnable without a tutorial, and the bearing chevron — with an archipelago
 * instead of a corridor, "which way" stopped being answerable from the
 * geometry alone.
 *
 * Frame discipline, which is a design constraint here and not an optimisation
 * pass (docs/taste.md): every element reference is cached at construction,
 * every value is quantised to the precision it is displayed at, and nothing is
 * written to the DOM unless that quantised value actually changed. The only
 * per-frame writes in the steady state are two `transform`s (composited, no
 * layout) and the timer's text. No `innerHTML` runs after construction.
 */

const $ = (id) => document.getElementById(id)

// ---------------------------------------------------------------- altimeter
//
// The tape is built once and translated. Range covers the planned world
// envelope (y -20..+90, docs/world-plan.md) with headroom at both ends so an
// overshoot or a fall toward the cloud deck still reads on the scale.
const ALT_MIN = -60
const ALT_MAX = 140
const ALT_STEP = 5           // a tick every 5 m
const ALT_MAJOR = 20         // a number every 20 m
const ALT_PPM = 2.2          // pixels per metre
const ALT_WINDOW = 190       // must match #altwin height in index.html

/** Screen-edge inset the bearing chevron orbits, in px. */
const NAV_PAD_X = 78
const NAV_PAD_Y = 96

export class Hud {
  constructor() {
    this.root = $('hud')
    this.timer = $('timer')
    this.splits = $('splits')
    this.pips = $('cppips')
    this.speedval = $('speedval')
    this.speednum = $('speednum')
    this.speedbar = $('speedbar')
    this.speedfill = $('speedfill')
    this.redline = $('redline')
    this.verb = $('verb')
    this.reticle = $('reticle')
    this.toast = $('toast')
    this.toastBig = this.toast.querySelector('.big')
    this.toastSub = this.toast.querySelector('.sub')
    this.overlay = $('overlay')
    this.chipDash = $('chip-dash')
    this.chipAir = $('chip-air')
    this.chipHook = $('chip-hook')

    this.compass = $('compass')
    this.needle = $('cneedle')
    this.cread = $('cread')
    this.creadNum = this.cread.firstChild        // text node before <small>
    this.cvert = $('cvert')
    this.alt = $('alt')
    this.altTape = $('alttape')
    this.altMark = $('altmark')
    this.altVal = $('altval')
    this.altNum = this.altVal.firstChild
    this.nav = $('nav')
    this.navChev = $('navchev')
    this.navDist = $('navdist')

    this._toastUntil = 0
    this._lastVerb = ''
    this._lastTime = ''
    this._lastSplits = ''
    this._lastKmh = -1
    this._lastFrac = -1
    this._hot = null
    this._dashReady = null
    this._airLeft = null
    this._hookReady = null
    this._pipCount = -1
    this._pipsLit = 0
    this._finished = null

    // nav state
    this._camera = null
    this._level = null
    this._target = null
    this._navHit = -1
    this._navFinished = null
    this._navLive = null
    this._navX = null
    this._navY = null
    this._navDeg = null
    this._navMetres = null
    this._navVert = null
    this._altPx = null
    this._altVal = null
    this._altMarkPx = null
    this._reticleHot = null

    this._w = window.innerWidth
    this._h = window.innerHeight
    // Cached rather than read per frame: touching innerWidth in the loop is a
    // forced layout flush on a frame that has nothing else to flush.
    this._onResize = () => { this._w = window.innerWidth; this._h = window.innerHeight }
    window.addEventListener('resize', this._onResize)

    this._buildAltTape()
    // The sprint threshold, stamped on the speed scale at the same fraction the
    // fill uses, so the mark and the bar can never disagree.
    this.redline.style.left = `${(TUNING.sprintSpeed / (TUNING.maxSpeed * 0.8)) * 100}%`
  }

  /**
   * Wire the wayfinding instruments. Optional — without it the HUD behaves
   * exactly as before and the compass, chevron and altimeter target marker
   * stay hidden; the altimeter itself still works, since it only needs the
   * player.
   *
   *   hud.setNav(camera, level)
   *
   * `level` needs `.checkpoints` (each `{ position, reached }`) and, if it has
   * one, `.finish`. Neither is mutated.
   */
  setNav(camera, level) {
    this._camera = camera || null
    this._level = level || null
    this._navHit = -1          // force a target recompute on the next update
    this._target = null
    if (this._camera && this._level) this.compass.classList.add('live')
  }

  setOverlay(visible) {
    this.overlay.classList.toggle('hidden', !visible)
  }

  update(now, { time, player, checkpointsHit, checkpointsTotal, finished }) {
    const t = formatTime(time)
    if (t !== this._lastTime) { this._lastTime = t; this.timer.textContent = t }

    const splits = finished ? 'route complete' : `checkpoint ${checkpointsHit} / ${checkpointsTotal}`
    if (splits !== this._lastSplits) { this._lastSplits = splits; this.splits.textContent = splits }

    if (finished !== this._finished) {
      this._finished = finished
      this.root.classList.toggle('finished', !!finished)
    }

    this._updatePips(checkpointsHit, checkpointsTotal)

    // km/h reads more legibly than m/s at a glance, and makes the difference
    // between a good line and a lazy one feel like it matters.
    const kmh = Math.round(player.speed3d * 3.6)
    if (kmh !== this._lastKmh) { this._lastKmh = kmh; this.speednum.textContent = kmh }

    // Quantised to the pixel the bar can actually show; below that the write is
    // invisible and only costs a style recalc.
    const frac = Math.round(Math.min(1, player.speed / (TUNING.maxSpeed * 0.8)) * 200)
    if (frac !== this._lastFrac) {
      this._lastFrac = frac
      this.speedfill.style.width = `${frac * 0.5}%`
    }
    // The bar runs hot once you are past sprint speed — the visual signal that
    // you are now carrying momentum rather than merely running. A class, so the
    // look lives in CSS and the per-frame cost is a cached boolean compare.
    const hot = player.speed > TUNING.sprintSpeed
    if (hot !== this._hot) { this._hot = hot; this.speedbar.classList.toggle('hot', hot) }

    const retHot = player.wallRunning || !!player.aimedAnchor
    if (retHot !== this._reticleHot) {
      this._reticleHot = retHot
      this.reticle.classList.toggle('hot', retHot)
    }

    // Ability availability has to be *visible*. An air dash that silently
    // does nothing because the charge is spent is indistinguishable from an
    // air dash that is broken — which is exactly how it got reported.
    const dashReady = player.dashReady && player.dashCooldown <= 0
    if (dashReady !== this._dashReady) {
      this._dashReady = dashReady
      this.chipDash.classList.toggle('ready', dashReady)
    }
    const airLeft = player.airJumpsLeft > 0
    if (airLeft !== this._airLeft) {
      this._airLeft = airLeft
      this.chipAir.classList.toggle('ready', airLeft)
    }
    // The hook chip lights only when there is actually something in range to
    // grab, so it doubles as the targeting readout rather than just a cooldown.
    const hookReady = player.grappleCooldown <= 0 && !!player.aimedAnchor
    if (hookReady !== this._hookReady) {
      this._hookReady = hookReady
      this.chipHook.classList.toggle('ready', hookReady)
    }

    const verb = currentVerb(player)
    if (verb !== this._lastVerb) {
      this._lastVerb = verb
      this.verb.textContent = verb
      this.verb.classList.toggle('on', verb !== '')
    }

    this._updateAltimeter(player.position.y)
    this._updateNav(player, checkpointsHit, finished)

    if (this._toastUntil && now > this._toastUntil) {
      this._toastUntil = 0
      this.toast.classList.remove('on')
    }
  }

  showToast(big, sub, now, duration = 2.2) {
    this._setToast(big, sub, 'split')
    this._toastUntil = now + duration
  }

  holdToast(big, sub) {
    this._setToast(big, sub, 'hold')
    this._toastUntil = 0
  }

  // ------------------------------------------------------------- internals

  _setToast(big, sub, mode) {
    this.toastBig.textContent = big
    this.toastSub.textContent = sub
    // Re-trigger the entry animation. The forced reflow is deliberate and
    // happens only on a checkpoint or a finish — never in the steady state.
    this.toast.className = mode
    void this.toast.offsetWidth
    this.toast.classList.add('on')
  }

  /**
   * A punched register strip. Counting filled holes in peripheral vision is
   * faster than reading a fraction; past fourteen checkpoints it stops being
   * countable at a glance and the text carries it alone.
   */
  _updatePips(hit, total) {
    if (total !== this._pipCount) {
      this._pipCount = total
      this._pipsLit = 0
      const usable = total > 0 && total <= 14
      this.pips.classList.toggle('empty', !usable)
      while (this.pips.firstChild) this.pips.removeChild(this.pips.firstChild)
      if (usable) {
        for (let i = 0; i < total; i++) this.pips.appendChild(document.createElement('b'))
      }
    }
    if (this.pips.childElementCount === 0) return
    if (hit === this._pipsLit) return
    const kids = this.pips.children
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('hit', i < hit)
    this._pipsLit = hit
  }

  /** Ticks and numbers, built once; only the tape's transform moves. */
  _buildAltTape() {
    const frag = document.createDocumentFragment()
    for (let a = ALT_MIN; a <= ALT_MAX; a += ALT_STEP) {
      const row = document.createElement('div')
      const major = a % ALT_MAJOR === 0
      row.className = 't ' + (a === 0 ? 'major datum' : major ? 'major' : 'minor')
      row.style.top = `${(ALT_MAX - a) * ALT_PPM}px`
      if (major) row.textContent = String(a)
      frag.appendChild(row)
    }
    this.altTape.appendChild(frag)
    this.altTape.style.height = `${(ALT_MAX - ALT_MIN) * ALT_PPM}px`
    this.alt.classList.add('live')
  }

  _updateAltimeter(y) {
    const px = Math.round(ALT_WINDOW * 0.5 - (ALT_MAX - y) * ALT_PPM)
    if (px !== this._altPx) {
      this._altPx = px
      this.altTape.style.transform = `translateY(${px}px)`
    }
    const m = Math.round(y)
    if (m !== this._altVal) { this._altVal = m; this.altNum.nodeValue = String(m) }
  }

  /**
   * Bearing to the next drop.
   *
   * Two readouts off one calculation: a needle on the rose for the number, and
   * a chevron that orbits the *edge* of the screen for the glance. The chevron
   * is kept out of the middle of the frame on purpose — the centre is where the
   * route is read, and a marker parked there is exactly the floating label
   * docs/taste.md forbids. Straight ahead puts it at top centre, dead behind
   * puts it at bottom centre, and everything in between slides continuously
   * around the perimeter, so direction is carried by position alone and never
   * needs to be decoded.
   */
  _updateNav(player, checkpointsHit, finished) {
    const cam = this._camera
    if (!cam || !this._level) return

    // Recompute the target only when the run state moved, not every frame.
    if (checkpointsHit !== this._navHit || finished !== this._navFinished) {
      this._navHit = checkpointsHit
      this._navFinished = finished
      this._target = finished ? null : this._pickTarget()
      this._navMetres = null
      this._navVert = null
      this._altMarkPx = null
      this.altMark.classList.toggle('on', !!this._target)
      if (this._target) {
        const mp = Math.round((ALT_MAX - this._target.y) * ALT_PPM)
        if (mp !== this._altMarkPx) { this._altMarkPx = mp; this.altMark.style.top = `${mp}px` }
      }
    }

    const target = this._target
    const live = !!target
    if (live !== this._navLive) {
      this._navLive = live
      this.nav.classList.toggle('live', live)
      this.compass.classList.toggle('live', live)
    }
    if (!target) return

    // Direction in view space. Built from the live position/quaternion rather
    // than camera.matrixWorld, which has not been recomputed yet at HUD time —
    // reading the matrix here would draw a bearing one frame stale.
    let vx = target.x - cam.position.x
    let vy = target.y - cam.position.y
    let vz = target.z - cam.position.z
    const dist = Math.sqrt(vx * vx + vy * vy + vz * vz)

    const q = cam.quaternion
    // Rotate by the inverse (conjugate) of the camera orientation, expanded
    // inline so the hot path allocates nothing.
    const ix = -q.x, iy = -q.y, iz = -q.z, iw = q.w
    const tx = 2 * (iy * vz - iz * vy)
    const ty = 2 * (iz * vx - ix * vz)
    const tz = 2 * (ix * vy - iy * vx)
    const lx = vx + iw * tx + (iy * tz - iz * ty)
    const lz = vz + iw * tz + (ix * ty - iy * tx)

    // 0 = dead ahead, +90 = to the right, 180 = behind.
    const bearing = Math.atan2(lx, -lz)
    const deg = Math.round(bearing * 57.29577951308232)
    if (deg !== this._navDeg) {
      this._navDeg = deg
      this.navChev.style.transform = `rotate(${deg}deg)`
      this.needle.style.transform = `rotate(${deg}deg)`
    }

    // Where that bearing meets the inset screen rectangle.
    const dx = Math.sin(bearing)
    const dy = -Math.cos(bearing)
    const hw = Math.max(40, this._w * 0.5 - NAV_PAD_X)
    const hh = Math.max(40, this._h * 0.5 - NAV_PAD_Y)
    const k = Math.min(hw / Math.max(Math.abs(dx), 1e-4), hh / Math.max(Math.abs(dy), 1e-4))
    const x = Math.round(dx * k)
    const y = Math.round(dy * k)
    if (x !== this._navX || y !== this._navY) {
      this._navX = x
      this._navY = y
      this.nav.style.transform = `translate(${x}px, ${y}px)`
    }

    const metres = Math.round(dist)
    if (metres !== this._navMetres) {
      this._navMetres = metres
      const label = `${metres} m`
      this.navDist.textContent = label
      this.creadNum.nodeValue = String(metres)
    }

    // Vertical separation is the other half of wayfinding in a world that runs
    // from y -20 to +90: a drop 40 m straight up is not the same problem as one
    // 40 m out. Below the threshold it stays blank rather than flickering.
    const rise = Math.round(target.y - player.position.y)
    const vert = rise > 5 ? `▲ ${rise} m` : rise < -5 ? `▼ ${-rise} m` : ''
    if (vert !== this._navVert) { this._navVert = vert; this.cvert.textContent = vert }
  }

  /** First unreached checkpoint, else the finish. Read-only over the level. */
  _pickTarget() {
    const cps = this._level.checkpoints
    if (cps) {
      for (let i = 0; i < cps.length; i++) {
        if (!cps[i].reached) return cps[i].position
      }
    }
    return this._level.finish || null
  }
}

function currentVerb(p) {
  if (p.grappling) return 'grapple'
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
