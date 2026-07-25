/**
 * All sound is synthesized live with the Web Audio API. There are no audio
 * files in this repo and there never will be.
 *
 * Per docs/taste.md, audio here is *feedback*, not decoration: it exists so a
 * player knows a movement state changed without taking their eyes off the
 * route. That is why every cue is short, transient-heavy, and pitched
 * distinctly from its neighbours — you should be able to tell a vault from a
 * wall-jump with your eyes closed.
 *
 * The palette is brass and porcelain, so the cues lean metallic and struck
 * rather than percussive-electronic.
 */

/**
 * Round-robin footstep timbres. Six is enough that a sprint never repeats
 * audibly; fewer and the ear locks onto the cycle within a couple of seconds.
 */
const STEP_VARIANTS = [
  { body: 0, tex: 1500, bright: 1.00 },
  { body: 7, tex: 1880, bright: 0.86 },
  { body: -5, tex: 1320, bright: 1.12 },
  { body: 3, tex: 2140, bright: 0.94 },
  { body: -9, tex: 1660, bright: 1.05 },
  { body: 11, tex: 1180, bright: 0.80 },
]

export class Audio {
  constructor() {
    this._stepRR = 0
    this.ctx = null
    this.ready = false
    this.master = null
    this._noise = null
    this._wind = null
    this._windGain = null
    this._scrape = null
    this._scrapeGain = null
  }

  /** Must be called from a real user gesture or the context stays suspended. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume()
      return
    }
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    this.ctx = ctx

    this.master = ctx.createGain()
    this.master.gain.value = 0.55
    // A gentle limiter so a pile-up of cues never clips.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    comp.ratio.value = 6
    comp.attack.value = 0.004
    comp.release.value = 0.18
    this.master.connect(comp).connect(ctx.destination)

    this._noise = makeNoiseBuffer(ctx, 2.0)
    this._buildWind()
    this._buildScrape()
    this.ready = true
  }

  // ------------------------------------------------------------ continuous

  /** Wind rises with speed — the ambient readout of how fast you are going. */
  _buildWind() {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this._noise
    src.loop = true

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 520
    lp.Q.value = 0.6

    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 120

    const gain = ctx.createGain()
    gain.gain.value = 0

    src.connect(lp).connect(hp).connect(gain).connect(this.master)
    src.start()
    this._wind = lp
    this._windGain = gain
  }

  /** Metal-on-metal bed that only sounds while actually attached to a wall. */
  _buildScrape() {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this._noise
    src.loop = true

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2400
    bp.Q.value = 3.2

    const gain = ctx.createGain()
    gain.gain.value = 0

    src.connect(bp).connect(gain).connect(this.master)
    src.start()
    this._scrape = bp
    this._scrapeGain = gain
  }

  /**
   * Called every frame with the live player state.
   *
   * `refSpeed` is the speed at which wind reaches full volume, and it must be
   * near the TOP of the achievable range, not at sprint speed. Normalising
   * against sprint meant the wind pinned at maximum the instant you hit ~40
   * km/h and then sounded identical at 60, 80 and 120 — the exact speeds
   * where the player most wants to hear that they are going faster.
   */
  update(player, refSpeed) {
    if (!this.ready) return
    const t = this.ctx.currentTime

    // Below this there is no wind at all: walking around should be quiet.
    const FLOOR = 7.0
    const s = Math.min(1, Math.max(0, (player.speed3d - FLOOR) / (refSpeed - FLOOR)))

    // Gentler curve and a much lower ceiling. Wind is a bed under the mix,
    // not an event — it was drowning the footsteps and landings that actually
    // carry information.
    const windTarget = Math.pow(s, 1.7) * 0.15 + (player.grounded ? 0 : 0.012)
    this._windGain.gain.setTargetAtTime(windTarget, t, 0.14)
    // Open the filter with speed too, so it brightens as well as swells —
    // that spectral change is most of what the ear reads as "faster".
    this._wind.frequency.setTargetAtTime(380 + s * 1900, t, 0.2)

    const scrapeTarget = player.wallRunning ? 0.04 + s * 0.07 : 0
    this._scrapeGain.gain.setTargetAtTime(scrapeTarget, t, 0.05)
    this._scrape.frequency.setTargetAtTime(1800 + s * 2200, t, 0.1)
  }

  // ---------------------------------------------------------------- events

  handle(events) {
    if (!this.ready) return
    for (const e of events) {
      switch (e.type) {
        case 'step': this.step(e.speed); break
        case 'jump': this.jump(); break
        case 'land': this.land(e.impact); break
        case 'vault': this.vault(); break
        case 'wallrun': this.wallrun(); break
        case 'walljump': this.walljump(); break
        case 'slide': this.slide(); break
        case 'dash': this.dash(); break
        case 'airjump': this.airjump(); break
        case 'grapple': this.grapple(); break
        case 'grapplerelease': this.grappleRelease(); break
        case 'climb': this.climb(); break
      }
    }
  }

  /**
   * Grapple fire: the cuff's spring releasing, the line paying out, then the
   * hook biting. Three distinct moments, scheduled rather than stacked, so
   * the ear hears a mechanism operate instead of one undifferentiated clank.
   */
  grapple() {
    const t = this.ctx.currentTime
    // Spring release.
    this._tone({ freq: 1400, to: 700, type: 'square', dur: 0.05, gain: 0.05, at: t })
    // Line paying out — a rising hiss.
    this._noiseBurst({ dur: 0.16, type: 'bandpass', freq: 2200, q: 1.4, gain: 0.14, decay: 0.14, at: t + 0.01 })
    // The bite: brass on brass.
    this._noiseBurst({ dur: 0.1, type: 'bandpass', freq: 3600, q: 4.0, gain: 0.20, decay: 0.07, at: t + 0.1 })
    this._tone({ freq: 620, type: 'sine', dur: 0.34, gain: 0.10, at: t + 0.1 })
    this._tone({ freq: 1710, type: 'sine', dur: 0.22, gain: 0.05, at: t + 0.1 })
  }

  /** Release: the line detaching and whipping back into the cuff. */
  grappleRelease() {
    this._noiseBurst({ dur: 0.2, type: 'highpass', freq: 1800, gain: 0.14, decay: 0.16 })
    this._tone({ freq: 900, to: 1500, type: 'triangle', dur: 0.12, gain: 0.06 })
  }

  /** Air jump: the clockwork cape snapping open, then catching air. */
  airjump() {
    // A brass ratchet click, then the whump of fabric filling.
    this._tone({ freq: 880, to: 1180, type: 'square', dur: 0.05, gain: 0.05 })
    this._noiseBurst({ dur: 0.09, type: 'bandpass', freq: 3400, q: 3.0, gain: 0.16, decay: 0.06 })
    this._noiseBurst({ dur: 0.3, type: 'lowpass', freq: 800, gain: 0.26, decay: 0.24 })
    this._tone({ freq: 240, to: 460, type: 'triangle', dur: 0.22, gain: 0.12 })
  }

  /** Dash: a sharp intake of air, pitched up. Reads as effort, not machinery. */
  dash() {
    this._noiseBurst({ dur: 0.22, type: 'bandpass', freq: 1700, q: 0.9, gain: 0.30, decay: 0.17 })
    this._tone({ freq: 300, to: 720, type: 'triangle', dur: 0.19, gain: 0.11 })
  }

  /** Vertical wall-run: boots scrabbling upward, rising in pitch. */
  climb() {
    this._noiseBurst({ dur: 0.34, type: 'bandpass', freq: 1100, q: 1.6, gain: 0.26, decay: 0.3 })
    this._tone({ freq: 190, to: 430, type: 'triangle', dur: 0.3, gain: 0.11 })
  }

  /**
   * A boot on porcelain.
   *
   * Every impact in the game is built the same way — **transient, body,
   * texture** — because that is how a real one arrives at the ear: the
   * contact click, then the mass of the thing that was struck, then the
   * surface it was struck against. Getting the envelope shapes right matters
   * far more than getting the filter frequencies right.
   *
   * The round-robin table is what stops a sprint sounding like a looping
   * sample. Six timbres cycled with an offset, plus per-step pitch and level
   * jitter, means the same footfall never lands twice in a row.
   */
  step(speed) {
    const v = Math.min(1, 0.24 + speed / 40)
    const rr = STEP_VARIANTS[this._stepRR % STEP_VARIANTS.length]
    this._stepRR += 1 + ((Math.random() * 2) | 0)   // advance 1-2 so it never cycles predictably
    const jitter = 0.92 + Math.random() * 0.16

    // 1. transient — the leading edge of boot on glaze
    this._noiseBurst({
      dur: 0.03, type: 'highpass', freq: 3800 * jitter,
      gain: v * 0.16 * rr.bright, decay: 0.018,
    })
    // 2. body — the player's mass arriving
    this._tone({
      freq: (86 + rr.body) * jitter, to: (58 + rr.body) * jitter,
      type: 'sine', dur: 0.075, gain: v * 0.17,
    })
    // 3. texture — the surface itself
    this._noiseBurst({
      dur: 0.075, type: 'bandpass', freq: rr.tex * jitter, q: 1.4,
      gain: v * 0.22 * rr.bright, decay: 0.05,
    })
  }

  jump() {
    this._tone({ freq: 220, to: 380, type: 'triangle', dur: 0.16, gain: 0.16 })
    this._noiseBurst({ dur: 0.14, type: 'highpass', freq: 900, gain: 0.10, decay: 0.12 })
  }

  /**
   * Landing: the same transient/body/texture stack as a footstep, but the
   * proportions invert with impact. A gentle landing is mostly texture; a
   * hard one is mostly body, with a debris tail that only appears once the
   * impact is genuinely heavy — that threshold is what makes a big drop feel
   * different in kind rather than just louder.
   */
  land(impact) {
    const g = 0.20 + impact * 0.42
    const jitter = 0.94 + Math.random() * 0.12

    this._noiseBurst({ dur: 0.03, type: 'highpass', freq: 3000, gain: g * 0.22, decay: 0.02 })
    this._tone({
      freq: (150 - impact * 30) * jitter, to: (52 - impact * 8) * jitter,
      type: 'sine', dur: 0.2 + impact * 0.18, gain: g,
    })
    this._noiseBurst({
      dur: 0.17, type: 'lowpass', freq: (700 + impact * 900) * jitter,
      gain: g * 0.62, decay: 0.13,
    })
    if (impact > 0.45) {
      // Debris: loose grit skittering after a hard arrival.
      this._noiseBurst({
        dur: 0.34, type: 'bandpass', freq: 2600, q: 1.1,
        gain: (impact - 0.45) * 0.30, decay: 0.3, at: this.ctx.currentTime + 0.045,
      })
    }
  }

  /** Vault reads as a hand slapping stone then pushing off. */
  vault() {
    this._noiseBurst({ dur: 0.1, type: 'bandpass', freq: 900, q: 1.1, gain: 0.26, decay: 0.08 })
    this._tone({ freq: 160, to: 250, type: 'triangle', dur: 0.13, gain: 0.13 })
  }

  wallrun() {
    this._noiseBurst({ dur: 0.2, type: 'bandpass', freq: 3000, q: 2.6, gain: 0.20, decay: 0.16 })
  }

  /** Wall-jump is the most metallic cue: a struck brass panel. */
  walljump() {
    this._tone({ freq: 340, to: 240, type: 'square', dur: 0.16, gain: 0.09 })
    this._tone({ freq: 690, type: 'sine', dur: 0.28, gain: 0.10 })
    this._noiseBurst({ dur: 0.14, type: 'bandpass', freq: 2600, q: 2.0, gain: 0.20, decay: 0.11 })
  }

  slide() {
    this._noiseBurst({ dur: 0.5, type: 'bandpass', freq: 1200, q: 1.2, gain: 0.24, decay: 0.42 })
  }

  /** Checkpoint: a small brass bell, struck once. */
  checkpoint() {
    if (!this.ready) return
    const partials = [1, 2.76, 5.4]
    partials.forEach((p, i) => {
      this._tone({
        freq: 520 * p,
        type: 'sine',
        dur: 1.1 - i * 0.24,
        gain: 0.16 / (i + 1.4),
        attack: 0.003,
      })
    })
  }

  /** Finish: the same bell, as a chord, with the low octave under it. */
  finish() {
    if (!this.ready) return
    const t = this.ctx.currentTime
    ;[0, 0.09, 0.2].forEach((delay, i) => {
      const f = [520, 660, 784][i]
      ;[1, 2.76].forEach((p, j) => {
        this._tone({
          freq: f * p,
          type: 'sine',
          dur: 2.0 - j * 0.5,
          gain: 0.13 / (j + 1.3),
          at: t + delay,
          attack: 0.004,
        })
      })
    })
    this._tone({ freq: 130, type: 'sine', dur: 2.4, gain: 0.14, at: t })
  }

  // ----------------------------------------------------------- synth prims

  _tone({ freq, to, type = 'sine', dur = 0.2, gain = 0.2, at, attack = 0.005 }) {
    const ctx = this.ctx
    const t0 = at ?? ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    if (to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur)

    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(g).connect(this.master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  _noiseBurst({ dur = 0.1, type = 'bandpass', freq = 1000, q = 1, gain = 0.2, decay = 0.08, at }) {
    const ctx = this.ctx
    const t0 = at ?? ctx.currentTime

    const src = ctx.createBufferSource()
    src.buffer = this._noise
    // Random offset into the buffer so repeated cues never phase-match.
    const offset = Math.random() * (this._noise.duration - dur - 0.05)

    const filt = ctx.createBiquadFilter()
    filt.type = type
    filt.frequency.setValueAtTime(freq, t0)
    filt.Q.value = q

    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, t0)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay)

    src.connect(filt).connect(g).connect(this.master)
    src.start(t0, Math.max(0, offset), dur)
  }
}

function makeNoiseBuffer(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  // Pink-ish noise (Voss-McCartney style running sum) — plain white noise is
  // too hissy to sit under a wind bed.
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.0990460
    b1 = 0.96300 * b1 + w * 0.2965164
    b2 = 0.57000 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28
  }
  return buf
}
