import { TUNING, getMode } from './player.js'

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
 * The wall gauge (`_updateWall`) is the same kind of exception and is held to
 * the same standard. It reports a budget the player is already spending; it
 * does not say which key to press. Ethan, playing: "it's not super intuitive
 * how you're running up the wall versus jumping off of it." The move was fixed
 * separately; what was left was that a climb and a lateral wall-run looked
 * identical on the panel and both ran out with no warning. So the two verbs
 * now differ by the ORIENTATION of the gauge — vertical for a climb, lateral
 * for a run — which is a fact about the move, not a caption on it.
 *
 * Frame discipline, which is a design constraint here and not an optimisation
 * pass (docs/taste.md): every element reference is cached at construction,
 * every value is quantised to the precision it is displayed at, and nothing is
 * written to the DOM unless that quantised value actually changed. The only
 * per-frame writes in the steady state are two `transform`s (composited, no
 * layout) and the timer's text. No `innerHTML` runs after construction.
 */

const $ = (id) => document.getElementById(id)

// ----------------------------------------------------------- progressive unlocks
//
// The move set is handed over one verb at a time, in course order, and each
// unlock is ANNOUNCED — an unlock the player does not notice is the same as no
// unlock. The schedule (which verb, which checkpoint) lives in the level
// (src/level.js `L.unlocks`); this file owns two things the level does not: how
// a verb is WITHHELD until its moment, and how the moment is spoken.
//
// The withholding rule that governs everything here: gating availability must
// not change how a verb FEELS once unlocked (the task's one hard movement
// constraint). So every hold is applied through a lever the controller ALREADY
// reads — `TUNING`, which player.js consults live every sim step, and a handful
// of player fields — and every release restores the exact base value. Once a
// verb is open, nothing below ever touches it again; it is bit-identical to the
// ungated game. The holds:
//
//   wall     TUNING.wallReach -> 0. Every wall probe (`_probeWall`/`_probeDir`)
//            offsets by wallReach, so at 0 no wall is ever found and the run,
//            the climb and the kick-off all simply do not fire. Collision is
//            unaffected (it uses radius, not reach), so you still cannot walk
//            through the wall — you just cannot yet run it.
//   double   TUNING.airJumps -> 0. player.js handles zero air jumps natively;
//            the double jump is absent and the AIR chip reads unavailable.
//   dash     player.dashCooldown -> Infinity. The dash trigger requires
//            `dashCooldown <= 0`, so it never fires and no burst is emitted.
//   grapple  player.anchors -> []. `_findAnchor` iterates the anchor list; an
//            empty one means the reticle never lights and F does nothing. The
//            LEVEL's anchor array is untouched, so tools/reachability.mjs (which
//            harvests level.anchors, not player.anchors) still sees them all.
//
// Jump is never actually withheld — it is the base verb and a game you cannot
// jump in is not playable — so its "hold" is a no-op and only its toast fires.
const EMPTY_ANCHORS = []

/** Per-course memory of which verbs the player has already been taught. */
const LEARN_KEY = 'skyline-courier:learned'

/**
 * The presentation and the mechanism for each verb.
 *
 * `big`/`sub` are functions so the grapple can name itself the TETHER in
 * Hardcore, where the cuff holds distance instead of reeling (see player.js
 * MODES.hardcore). `gate`/`release` are the hold and its exact undo; the ones
 * that touch the player tolerate a null player (they re-apply on the first
 * `update`, where the player is always in hand).
 */
const UNLOCK_INFO = {
  jump: {
    big: () => 'JUMP',
    sub: () => 'SPACE — clear the gaps ahead',
    gate: null,
    release: null,
  },
  wall: {
    big: () => 'WALL-RUN',
    sub: () => 'brass is runnable — hold into it, SPACE to kick off or climb',
    gate: (h) => { TUNING.wallReach = 0 },
    release: (h) => { TUNING.wallReach = h._baseWallReach },
  },
  double: {
    big: () => 'DOUBLE JUMP',
    sub: () => 'SPACE again in the air — for the wider gaps',
    gate: (h) => { TUNING.airJumps = 0 },
    release: (h) => { TUNING.airJumps = h._baseAirJumps },
  },
  dash: {
    big: () => 'DASH',
    sub: () => 'Q or right-click — commit across the long gaps',
    gate: (h, p) => { if (p) p.dashCooldown = Infinity },
    release: (h, p) => { if (p) p.dashCooldown = 0 },
  },
  grapple: {
    big: () => (getMode() === 'hardcore' ? 'TETHER' : 'GRAPPLE'),
    sub: () => (getMode() === 'hardcore'
      ? 'F on a brass anchor — swing the tether across'
      : 'F on a brass anchor — reach what you cannot jump'),
    gate: (h, p) => { if (p) p.anchors = EMPTY_ANCHORS },
    release: (h, p) => { if (p) p.anchors = h._level.anchors },
  },
}

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
    this.modetag = $('modetag')
    this.pips = $('cppips')
    this.speedval = $('speedval')
    this.speednum = $('speednum')
    this.speedbar = $('speedbar')
    this.speedfill = $('speedfill')
    this.redline = $('redline')
    this.verb = $('verb')
    this.wallBar = $('wallbar')
    this.wallRail = $('wallrail')
    this.wallBarFill = this.wallBar.firstElementChild
    this.wallRailFill = this.wallRail.firstElementChild
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
    this._lastKmh = -1
    this._lastFrac = -1
    this._hot = null
    this._dashReady = null
    this._airLeft = null
    this._hookReady = null
    this._hookSpent = null
    this._pipCount = -1
    this._pipsLit = 0

    // wall gauge state
    this._wallMode = 0         // 0 off, 1 climb (rail), 2 lateral run (bar)
    this._wallShown = 0        // which gauge is currently lit
    this._wallFrac = -1
    this._wallLow = null
    this._wallCoyote = null
    this._verbHeld = null

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

    // --- progressive unlocks (see the registry above and `_initUnlocks`) ---
    // The base values are captured here, before any hold can run, so a release
    // always restores exactly what the ungated game uses. Neither is overridden
    // by any difficulty mode, so the value read now is the value forever.
    this._baseWallReach = TUNING.wallReach
    this._baseAirJumps = TUNING.airJumps
    this._unlocks = null          // the level's schedule, or null if it opted out
    this._learned = null          // Set of verbs the player has already been taught
    this._unlocked = null         // { verb: bool } — the live availability
    this._unlockState = null      // the same booleans, published on the level

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
    // Set up the unlock schedule now, before the first frame runs: the TUNING
    // holds (wall, double) must be in place before player.update sees them, and
    // setNav is called at boot, ahead of the game loop starting.
    this._initUnlocks()
  }

  /**
   * Read the level's unlock schedule and apply the opening holds.
   *
   * Verbs the player has already learned on this course (persisted per level)
   * start open with no toast — a returning player, and a speedrunner re-running
   * a course they have finished, is handed the whole set at once rather than
   * re-taught. Everything else starts held, and `_updateUnlocks` opens it in
   * course order as the run reaches each checkpoint.
   */
  _initUnlocks() {
    const sched = this._level && this._level.unlocks
    this._unlocks = sched || null
    if (!sched) return
    this._learned = this._loadLearned()
    this._unlocked = {}
    this._unlockState = {}
    for (const u of sched) {
      const on = this._learned.has(u.verb)
      this._unlocked[u.verb] = on
      this._unlockState[u.verb] = on
      // TUNING holds apply immediately; the player-side holds (null player here)
      // are re-applied on the first `_updateUnlocks`, before the verb is usable.
      if (!on) UNLOCK_INFO[u.verb].gate?.(this, null)
    }
    // An introspection handle for the harness and the console — the same
    // booleans the holds are driven from. The game itself never reads it.
    this._level._unlockState = this._unlockState
  }

  /**
   * Open verbs as the run reaches their checkpoints, and hold the rest.
   *
   * Driven off `checkpointsHit` (monotonic, and never advanced by a skip a held
   * verb could take, so a section can never be entered before the verb it needs
   * has opened). A held verb has its hold re-asserted every frame: idempotent,
   * and it survives a difficulty switch rewriting TUNING under us. The instant a
   * verb opens it is released once and then left strictly alone, so its feel is
   * the ungated game's exactly.
   */
  _updateUnlocks(player, checkpointsHit, time) {
    if (!this._unlocks) return
    const started = time > 0            // the run has actually begun moving
    for (const u of this._unlocks) {
      const verb = u.verb
      const info = UNLOCK_INFO[verb]
      const want = this._learned.has(verb)
        || (checkpointsHit >= u.at && (verb !== 'jump' || started))
      if (want) {
        if (!this._unlocked[verb]) {
          this._unlocked[verb] = true
          this._unlockState[verb] = true
          info.release?.(this, player)
          // Speak it once, ever: a verb only reaches here unlearned the first
          // time it opens. Thereafter it is remembered and starts open silently.
          if (!this._learned.has(verb)) {
            this._learned.add(verb)
            this._saveLearned()
            this.showToast(info.big(), info.sub(), time, 2.6)
          }
        }
        // Already open: never touched again — pristine.
      } else {
        if (this._unlocked[verb]) { this._unlocked[verb] = false; this._unlockState[verb] = false }
        info.gate?.(this, player)
      }
    }
  }

  _loadLearned() {
    const set = new Set()
    const id = this._level && this._level.id
    if (!id) return set
    try {
      const raw = localStorage.getItem(`${LEARN_KEY}:${id}`)
      if (raw) for (const v of JSON.parse(raw)) set.add(v)
    } catch { /* private mode, or a corrupt value */ }
    return set
  }

  _saveLearned() {
    const id = this._level && this._level.id
    if (!id) return
    try { localStorage.setItem(`${LEARN_KEY}:${id}`, JSON.stringify([...this._learned])) }
    catch { /* private mode */ }
  }

  /**
   * Name the difficulty in the run register, and mark the picked card on the
   * start overlay.
   *
   * Written once per mode change, never per frame — the tag is a fact about the
   * run, not telemetry. It sits under the timer's hairline in the same engraved
   * caption style as ELEVATION and NEXT DROP, so it reads as a stamp on the
   * instrument rather than as a fourth number competing with the timer.
   */
  setMode(name, modes) {
    if (this.modetag) this.modetag.textContent = (modes?.[name]?.label || name)
    for (const btn of document.querySelectorAll('.modebtn')) {
      btn.classList.toggle('on', btn.dataset.mode === name)
      btn.setAttribute('aria-pressed', btn.dataset.mode === name ? 'true' : 'false')
    }
  }

  /**
   * Mark the picked world on the start overlay.
   *
   * Separate from `setMode` because the two choices are not the same kind of
   * thing: difficulty is applied live, but the world is baked into the IBL, the
   * grade LUT and every material at boot — so this only ever reflects what IS
   * booted, or what is about to be after the reload it triggers.
   */
  setMap(name) {
    for (const btn of document.querySelectorAll('.mapbtn')) {
      const on = btn.dataset.map === name
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      const note = btn.querySelector('[data-note]')
      // The card says what clicking it will actually do. A map swap that
      // reloads without warning reads as a crash; a label that says "reloads"
      // makes the same reload read as intended.
      if (note) note.textContent = on ? 'selected' : 'reloads'
    }
  }

  /**
   * Paint the best-time strip on each route card.
   *
   * `times` is `{ <map>: seconds | null }` for the CURRENTLY picked rules, and
   * `modeLabel` names those rules so the line reads as "your best on this route,
   * under these rules" — the board is scoped to both, so the rule has to be on
   * the line or the number is a lie the moment you change it. Persistence and
   * the scoping live in src/main.js; the HUD only renders what it is handed.
   *
   * Written on a mode change and on a finish, never per frame — a record is a
   * fact about a run, not telemetry, exactly like `setMode`.
   */
  setRecords(times, modeLabel) {
    for (const btn of document.querySelectorAll('.mapbtn')) {
      const rec = btn.querySelector('[data-rec]')
      if (!rec) continue
      const t = times ? times[btn.dataset.map] : null
      const timeEl = rec.querySelector('.rectime')
      const modeEl = rec.querySelector('.recmode')
      const has = t != null
      rec.classList.toggle('has', has)
      if (timeEl) timeEl.textContent = has ? formatTime(t) : '—'
      if (modeEl) modeEl.textContent = has ? (modeLabel || '') : 'no time yet'
    }
  }

  setOverlay(visible) {
    this.overlay.classList.toggle('hidden', !visible)
  }

  update(now, { time, player, checkpointsHit, checkpointsTotal, finished }) {
    const t = formatTime(time)
    if (t !== this._lastTime) { this._lastTime = t; this.timer.textContent = t }

    // Hold or open each verb for the frame the controller is about to run.
    // Placed before everything downstream so the availability the chips and the
    // reticle read below is this frame's, not last frame's.
    this._updateUnlocks(player, checkpointsHit, time)

    // The finish is announced by the held toast, which is an event the player
    // cannot miss. The run register used to *also* recolour itself, but the
    // only thing it recoloured was the checkpoint counter, and that is gone.
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
    // THREE STATES, not two. Ethan, playing NORMAL: "normal doesn't seem to
    // enforce or show as feedback that you only get one hook between landings."
    //
    // It IS enforced — `airChainLeft` gates AIMING in player.js, so the lamp
    // goes dark the instant the cuff is spent. The bug is that dark-because-
    // spent looked identical to dark-because-nothing-in-range, and in a course
    // with 211 anchors the second case is rare, so the first read as "the rule
    // isn't there" rather than as "you have used your hook".
    //
    // `spent` is now its own state: the chip stays lit but goes cold and
    // struck-through, which says I AM THE THING YOU JUST USED rather than
    // simply vanishing. `ready` is unchanged, so nothing about the working
    // case moves.
    const spent = player.airChainLeft <= 0 && !player.grappling
    const hookReady = player.grappleCooldown <= 0 && !!player.aimedAnchor
    if (spent !== this._hookSpent) {
      this._hookSpent = spent
      this.chipHook.classList.toggle('spent', spent)
    }
    if (hookReady !== this._hookReady) {
      this._hookReady = hookReady
      this.chipHook.classList.toggle('ready', hookReady)
    }

    this._updateWall(player)

    const verb = currentVerb(player)
    if (verb !== this._lastVerb) {
      this._lastVerb = verb
      // Blanking the word the instant a climb expires reads as the move
      // breaking. During the coyote window the wall is still there and Space
      // still kicks off it, so the word stays and only dims.
      if (verb !== '') this.verb.textContent = verb
      else if (this._wallMode === 0) this.verb.textContent = ''
      this.verb.classList.toggle('on', verb !== '' || this._wallMode !== 0)
    }
    const held = verb === '' && this._wallMode !== 0
    if (held !== this._verbHeld) {
      this._verbHeld = held
      this.verb.classList.toggle('hold', held)
      // Recovered here rather than above, because the coyote window can expire
      // on a frame where `verb` did not change (it was '' throughout).
      if (!held && verb === '') { this.verb.textContent = ''; this.verb.classList.remove('on') }
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

  /**
   * The wall budget.
   *
   * A climb runs `climbTime` and a lateral run runs `wallRunTime`, and both
   * used to end with no warning at all — which is most of why "running up the
   * wall versus jumping off it" read as unreliable rather than as timed. The
   * move was fine; it was invisible.
   *
   * Two gauges, one instrument. Which one lights is the *orientation of the
   * move you are in* — a rail up the side for a climb, a bar across for a
   * lateral run — so the two verbs the report confuses are told apart by
   * shape, before the word is read. Nothing is shown off a wall.
   *
   * Read-only over the player: `climbTimer`, `wallTimer`, `wallRunning` and
   * `wallCoyote` are all reported state. Nothing here can change a frame of
   * movement.
   */
  _updateWall(p) {
    const climbing = p.climbTimer > 0
    const running = !!p.wallRunning
    // The coyote window is otherwise completely invisible — 0.28 s in which
    // Space still kicks off a wall you are no longer touching. Showing the
    // gauge spent-but-lit is the only way a player learns it exists without
    // being told, so it holds whichever gauge was just live.
    const coyote = !climbing && !running && (p.wallCoyote > 0)
    const mode = climbing ? 1 : running ? 2 : coyote ? this._wallMode : 0
    this._wallMode = mode

    if (mode !== this._wallShown) {
      this._wallShown = mode
      this._wallFrac = -1        // force a fill write on the first frame of a mode
      this.wallRail.classList.toggle('on', mode === 1)
      this.wallBar.classList.toggle('on', mode === 2)
    }
    if (mode === 0) {
      // Cleared while invisible, so the *next* contact can never open on the
      // spent styling of the last one.
      if (this._wallCoyote !== false) {
        this._wallCoyote = false
        this.wallRail.classList.remove('coyote')
        this.wallBar.classList.remove('coyote')
      }
      if (this._wallLow !== false) {
        this._wallLow = false
        this.wallRail.classList.remove('low')
        this.wallBar.classList.remove('low')
      }
      return
    }

    if (coyote !== this._wallCoyote) {
      this._wallCoyote = coyote
      this.wallRail.classList.toggle('coyote', coyote)
      this.wallBar.classList.toggle('coyote', coyote)
    }

    // Quantised to 200 steps — a shade under a pixel on either gauge, so every
    // write that survives is a write the player can actually see.
    const raw = coyote ? 0
      : climbing ? p.climbTimer / TUNING.climbTime
      : p.wallTimer / TUNING.wallRunTime
    const frac = Math.round(Math.min(1, Math.max(0, raw)) * 200)
    if (frac !== this._wallFrac) {
      this._wallFrac = frac
      const s = frac * 0.005
      // scale, not width/height: composited, no layout, on a value that moves
      // every frame for the whole of a wall contact.
      if (mode === 1) this.wallRailFill.style.transform = `scaleY(${s})`
      else this.wallBarFill.style.transform = `scaleX(${s})`
    }
    const low = !coyote && frac <= 66
    if (low !== this._wallLow) {
      this._wallLow = low
      this.wallRail.classList.toggle('low', low)
      this.wallBar.classList.toggle('low', low)
    }
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
