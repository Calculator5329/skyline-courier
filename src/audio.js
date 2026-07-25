/**
 * All sound effects are synthesized live with the Web Audio API. There are no
 * SFX files in this repo and there never will be. (`src/music.js` streams
 * generated tracks from public/audio/ — that is the one carved-out exception
 * and it is not this file's business.)
 *
 * Per docs/taste.md, audio here is *feedback*, not decoration: it exists so a
 * player knows a movement state changed without taking their eyes off the
 * route. That is why every cue is short, transient-heavy, and pitched
 * distinctly from its neighbours — you should be able to tell a vault from a
 * wall-jump with your eyes closed.
 *
 * Per docs/art-direction.md the world is warm sandstone, ornate machined
 * brass, moss and water, floating in open sky. So the cues lean *struck metal
 * and dry stone*, never percussive-electronic, and the courier is a wind-up
 * machine, so there is a thin clockwork layer under the movement that you feel
 * more than you notice.
 *
 * ── How everything is built ────────────────────────────────────────────────
 *
 * Every impact is four layers, in this order, because that is the order they
 * arrive at a real ear:
 *
 *   1. transient — the leading edge of the contact (2-4 kHz, ~20 ms)
 *   2. body      — the mass of the thing that was struck (50-160 Hz)
 *   3. texture   — the surface it was struck against (band-passed noise)
 *   4. debris    — what came loose afterwards, only when it earned it
 *
 * Envelope shapes matter far more here than filter frequencies. A landing and
 * a footstep are the same four layers with different proportions, and getting
 * the proportions to move with impact is what makes a big drop feel different
 * in *kind* rather than just louder.
 *
 * ── Signal graph ──────────────────────────────────────────────────────────
 *
 *   voices ─┬─▶ bus.step   ─┐                 (bus = trim + reverb send tap)
 *           ├─▶ bus.impact ─┤
 *           ├─▶ bus.mech   ─┼─▶ mix ─▶ master ─▶ comp ─▶ softClip ─▶ out
 *           ├─▶ bus.air    ─┤          ▲
 *           ├─▶ bus.ui     ─┤          │
 *           └─▶ ambDuck ───▶ bus.amb ─┘         (wind/scrape/gear only)
 *                                     │
 *           bus.*.send ─▶ verbIn ─▶ convolver ─▶ verbTone ─▶ verbWet ─┘
 *
 * `master` stays a plain GainNode with the same name and meaning it always
 * had, because src/main.js hands it to Music as a destination. Do not rename
 * or re-type it without fixing that call site.
 *
 * The softClip at the end is a tanh curve over input [-1, 1]. It is what lets
 * me claim, structurally rather than by listening, that no pile-up of cues can
 * ever clip the output: a WaveShaper clamps out-of-range input to its endpoint
 * sample, so |output| <= tanh(1) = 0.762 no matter what arrives.
 */

// ---------------------------------------------------------------- constants

/** Speed of sound, m/s. Used to turn image-source distances into delays. */
const C_AIR = 343

/**
 * Voice budget. Every scheduled node is short and self-stopping, but a pile-up
 * (respawn spam, 20 events landing on one sim step) must not be able to
 * allocate an unbounded number of them. 64 voices per 100 ms is roughly eight
 * simultaneous full-fat cues, which is already more than the mix can resolve.
 */
const VOICE_BUDGET = 64
const VOICE_WINDOW = 0.1

/**
 * Hard ceiling on any single voice's peak gain. Nothing in here legitimately
 * needs more, and it means a bad multiplier upstream degrades to "too loud"
 * rather than "destroys the mix".
 */
const VOICE_MAX_GAIN = 0.75

/**
 * Per-category trims and reverb sends.
 *
 * The mix rule this table encodes: **the cues that carry information win.**
 * Landing impact, wall attach and grapple bite tell the player their movement
 * state changed; wind and footsteps are texture. When they collide, texture
 * loses. Ambience is additionally ducked under impacts (see `_duck`).
 *
 * Sends are deliberately uneven. Footsteps and impacts want the room, because
 * that is where "am I in a tunnel?" is legible. The wind bed wants none at
 * all — it is already diffuse, and reverberating it just smears the low mids
 * that the body layer of every impact lives in.
 */
const BUSES = {
  impact: { trim: 1.00, send: 0.90 },   // land, wall-jump, vault, grapple bite
  step:   { trim: 0.85, send: 0.55 },   // footfalls
  mech:   { trim: 0.70, send: 0.40 },   // clockwork: ticks, ratchets, detents
  air:    { trim: 0.80, send: 0.22 },   // dash, cape, line whip — mostly dry
  ui:     { trim: 0.90, send: 0.85 },   // checkpoint / finish bells
  amb:    { trim: 0.90, send: 0.00 },   // wind, wall scrape, gear whir
}

/**
 * Surface acoustics, keyed by the collision tag (`level.js` passes its `kind`
 * straight through to `CollisionWorld.addBox`, so the tag IS the material).
 *
 * The three that matter, and why they sound the way they do:
 *
 *   sandstone/terracotta — a dry crack. Porous stone has almost no sustain, so
 *     it is nearly all transient and texture with a stubby body and no ring.
 *   brass — rings. A struck plate has inharmonic partials (the 1 : 2.76 : 5.4
 *     series below is the classic circular-plate ratio), and that ring is the
 *     single most identifiable thing about this world's material palette.
 *   moss — soft and damped. The transient is LOW-passed rather than high-passed
 *     (there is no bright contact edge at all — that is the whole point), the
 *     texture sits an octave down, and it is quieter than everything else.
 *
 * `damp` scales the whole hit; `debris` scales the loose-grit tail after a
 * hard landing (moss has none — nothing skitters off a moss cap).
 */
const SURFACES = {
  stone: {
    tType: 'highpass', tFreq: 3400, tGain: 0.95, tDecay: 0.016,
    bodyHz: 88, bodyTo: 0.62, bodyDur: 0.070,
    texHz: 1500, texQ: 1.20, texGain: 1.00, texDecay: 0.048,
    ring: 0, ringHz: 0, damp: 1.00, debris: 1.00,
  },
  // The art direction's headline material: warm carved sandstone. Slightly
  // duller and grittier than generic stone — more texture, less edge.
  sandstone: {
    tType: 'highpass', tFreq: 2900, tGain: 0.80, tDecay: 0.018,
    bodyHz: 82, bodyTo: 0.60, bodyDur: 0.075,
    texHz: 1250, texQ: 0.95, texGain: 1.10, texDecay: 0.055,
    ring: 0, ringHz: 0, damp: 0.98, debris: 1.15,
  },
  terracotta: {
    tType: 'highpass', tFreq: 3100, tGain: 0.85, tDecay: 0.015,
    bodyHz: 96, bodyTo: 0.64, bodyDur: 0.062,
    texHz: 1720, texQ: 1.60, texGain: 0.95, texDecay: 0.042,
    // Fired clay has a short, hollow, quite-pitched ping. Not a brass ring —
    // one partial, and it is gone in a quarter of a second.
    ring: 0.22, ringHz: 940, damp: 1.00, debris: 0.85,
  },
  porcelain: {
    tType: 'highpass', tFreq: 4200, tGain: 1.10, tDecay: 0.012,
    bodyHz: 104, bodyTo: 0.66, bodyDur: 0.058,
    texHz: 2300, texQ: 2.10, texGain: 0.90, texDecay: 0.038,
    ring: 0.30, ringHz: 1480, damp: 1.00, debris: 0.70,
  },
  brass: {
    tType: 'highpass', tFreq: 4800, tGain: 1.05, tDecay: 0.014,
    bodyHz: 120, bodyTo: 0.72, bodyDur: 0.055,
    texHz: 3200, texQ: 3.20, texGain: 0.85, texDecay: 0.045,
    // The signature. Long enough to hear, short enough that a sprint across a
    // brass walkway does not turn into a wash of overlapping bells.
    ring: 0.85, ringHz: 660, damp: 1.00, debris: 0.45,
  },
  moss: {
    tType: 'lowpass', tFreq: 900, tGain: 0.55, tDecay: 0.030,
    bodyHz: 70, bodyTo: 0.58, bodyDur: 0.090,
    texHz: 620, texQ: 0.70, texGain: 0.80, texDecay: 0.075,
    ring: 0, ringHz: 0, damp: 0.72, debris: 0,
  },
}

/**
 * Substring rules for tags this file has never seen — the level is under
 * active construction and new `kind`s appear without warning. An unknown tag
 * must degrade to something plausible rather than to silence or a throw.
 */
const SURFACE_ALIASES = [
  ['moss', 'moss'], ['grass', 'moss'], ['vine', 'moss'], ['leaf', 'moss'],
  ['brass', 'brass'], ['metal', 'brass'], ['copper', 'brass'], ['gear', 'brass'],
  ['bronze', 'brass'],
  ['porcelain', 'porcelain'], ['glass', 'porcelain'], ['tile', 'porcelain'],
  ['terracotta', 'terracotta'], ['clay', 'terracotta'], ['brick', 'terracotta'],
  ['sand', 'sandstone'], ['ochre', 'sandstone'], ['stone', 'stone'],
  ['rock', 'stone'], ['wood', 'sandstone'], ['plank', 'sandstone'],
]

/**
 * Round-robin tables. Six is the magic number for footsteps — fewer and the
 * ear locks onto the cycle within a couple of seconds of sprinting. The rarer
 * cues get four or five, which is plenty: you never hear two wall-jumps
 * quickly enough to compare them the way you hear two footfalls.
 *
 * Every table is *multipliers*, not absolute values, so the surface profile
 * above stays the thing that decides what a hit sounds like and the variant
 * only decides which instance of that hit you got.
 */
const STEP_RR = [
  { body: 1.00, tex: 1.00, bright: 1.00 },
  { body: 1.08, tex: 1.25, bright: 0.86 },
  { body: 0.94, tex: 0.88, bright: 1.12 },
  { body: 1.03, tex: 1.43, bright: 0.94 },
  { body: 0.90, tex: 1.11, bright: 1.05 },
  { body: 1.12, tex: 0.79, bright: 0.80 },
]

const LAND_RR = [
  { body: 1.00, tex: 1.00, bright: 1.00, debris: 1.00 },
  { body: 0.93, tex: 1.18, bright: 1.09, debris: 0.80 },
  { body: 1.07, tex: 0.85, bright: 0.90, debris: 1.22 },
  { body: 0.97, tex: 1.32, bright: 1.05, debris: 0.94 },
  { body: 1.11, tex: 0.93, bright: 0.83, debris: 1.10 },
]

const WALLJUMP_RR = [
  { kick: 1.00, ring: 1.00, tex: 1.00 },
  { kick: 1.09, ring: 0.92, tex: 1.21 },
  { kick: 0.91, ring: 1.14, tex: 0.86 },
  { kick: 1.04, ring: 0.86, tex: 1.09 },
  { kick: 0.95, ring: 1.07, tex: 0.94 },
]

const VAULT_RR = [
  { slap: 1.00, push: 1.00, scuff: 1.00 },
  { slap: 1.13, push: 0.94, scuff: 0.86 },
  { slap: 0.88, push: 1.08, scuff: 1.19 },
  { slap: 1.05, push: 0.90, scuff: 1.02 },
]

const DASH_RR = [
  { air: 1.00, whoosh: 1.00, spring: 1.00 },
  { air: 1.12, whoosh: 0.90, spring: 1.08 },
  { air: 0.89, whoosh: 1.14, spring: 0.93 },
  { air: 1.04, whoosh: 0.96, spring: 1.16 },
]

const GRAPPLE_RR = [
  { spring: 1.00, line: 1.00, bite: 1.00 },
  { spring: 1.11, line: 0.88, bite: 0.95 },
  { spring: 0.90, line: 1.16, bite: 1.07 },
  { spring: 1.06, line: 0.94, bite: 0.89 },
  { spring: 0.94, line: 1.07, bite: 1.13 },
]

const AIRJUMP_RR = [
  { detent: 1.00, canopy: 1.00, lift: 1.00 },
  { detent: 1.08, canopy: 0.93, lift: 1.06 },
  { detent: 0.92, canopy: 1.10, lift: 0.94 },
  { detent: 1.03, canopy: 0.97, lift: 1.11 },
]

/**
 * Directions the space probe fires along, as unit vectors, flat-packed.
 *
 * Four cardinals, four diagonals, and straight up. Down is deliberately absent
 * — there is nearly always floor below and it carries no information about
 * enclosure. Up carries a lot: a ceiling is the difference between the
 * underpass and an open island, and it is weighted double for exactly that
 * reason (see `_enclosure`).
 */
const D = Math.SQRT1_2
const PROBE_DIRS = new Float32Array([
  1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, -1,
  D, 0, D, -D, 0, D, D, 0, -D, -D, 0, -D,
  0, 1, 0,
])
const PROBE_COUNT = PROBE_DIRS.length / 3
/** Beyond this a surface contributes nothing audible in the way of early
 *  reflections, and it is also the range past which scanning boxes is wasted
 *  work. 14 m is about two island widths. */
const PROBE_RANGE = 14

export class Audio {
  constructor() {
    this.ctx = null
    this.ready = false
    this.master = null

    // Round-robin cursors, one per cue family.
    this._rr = {
      step: 0, land: 0, walljump: 0, vault: 0,
      dash: 0, grapple: 0, airjump: 0, wallrun: 0,
    }

    // Deterministic jitter source. Seeded so that a given sequence of events
    // sounds identical between runs — which is what makes "did my change make
    // the landing brighter?" an answerable question — while still giving every
    // individual event its own detune and level.
    this._seed = 0x9E3779B9 >>> 0

    this._noise = null
    this._buses = null
    this._wind = null
    this._windGain = null
    this._windSizzle = null
    this._scrape = null
    this._scrapeGain = null
    this._gearGain = null
    this._gearLfo = null
    this._gearDepth = null
    this._ambDuck = null
    this._verbIn = null
    this._verbWet = null
    this._verbTone = null

    // Space probe state. All fixed-size and preallocated: the update path must
    // not allocate, and this is the only part of it that touches the world.
    this._probeHits = new Float32Array(PROBE_COUNT).fill(PROBE_RANGE)
    this._probeCursor = 0
    this._boxes = null
    this._enclosure = 0
    /** Set by `update`, read by `handle` — see the note there. */
    this._player = null

    // Cached ground surface, refreshed at most every `_surfInterval` seconds.
    // A sprint fires ~4 footsteps a second and a step + land can land on the
    // same sim step, so caching removes nearly all of the scan cost.
    this._surf = SURFACES.stone
    this._surfAt = -1
    this._surfInterval = 0.05

    this._voiceWindow = -1
    this._voiceCount = 0
    this._tagCache = null
  }

  /** Must be called from a real user gesture or the context stays suspended. */
  init() {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume()
        return
      }
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      this.ctx = ctx
      this._tagCache = new Map()

      // --- master chain ---------------------------------------------------
      // 0.55 leaves ~5 dB of headroom before the compressor does any work at
      // all, so ordinary play is completely uncompressed and only a pile-up
      // ever engages it.
      this.master = ctx.createGain()
      this.master.gain.value = 0.55

      const comp = ctx.createDynamicsCompressor()
      // Lower and harder than a mix-bus compressor would be, because this is
      // a safety device, not a tone shaper: it only ever sees signal when
      // several cues stack, and its job then is to hold them together rather
      // than to be inaudible.
      comp.threshold.value = -18
      comp.knee.value = 8
      comp.ratio.value = 12
      comp.attack.value = 0.003    // fast enough to catch a landing transient
      comp.release.value = 0.22    // slow enough not to pump under footsteps

      const softClip = ctx.createWaveShaper()
      softClip.curve = makeSoftClipCurve()
      softClip.oversample = '2x'   // the curve only bends near full scale, so
                                   // 2x is enough to keep its harmonics tidy

      this.master.connect(comp).connect(softClip).connect(ctx.destination)

      this._noise = makeNoiseBuffer(ctx, 2.0, this._rand.bind(this))
      this._buildReverb()
      this._buildBuses()
      this._buildWind()
      this._buildScrape()
      this._buildGearbox()
      this.ready = true
    } catch (err) {
      // Callers do not check, and a missing AudioContext must never take the
      // game down. Silence is an acceptable failure mode; a thrown exception
      // out of a pointer-lock click handler is not.
      this.ready = false
    }
  }

  // ------------------------------------------------------------------ graph

  /**
   * One gain per category, each with its own tap into the reverb.
   *
   * Buses exist so that the *relationship* between categories is a number in
   * one table rather than an emergent property of forty scattered gain
   * arguments. When wind drowns footsteps, the fix is one line here.
   */
  _buildBuses() {
    const ctx = this.ctx
    this._buses = {}
    for (const name in BUSES) {
      const spec = BUSES[name]
      const g = ctx.createGain()
      g.gain.value = spec.trim
      g.connect(this.master)
      if (spec.send > 0) {
        const send = ctx.createGain()
        send.gain.value = spec.send
        g.connect(send).connect(this._verbIn)
      }
      this._buses[name] = g
    }

    // Ambience sits behind an extra duck node so an important transient can
    // pull the wind down out of its way without touching the bus trim.
    this._ambDuck = ctx.createGain()
    this._ambDuck.gain.value = 1
    this._ambDuck.connect(this._buses.amb)
  }

  /**
   * A procedurally generated room, in two parts.
   *
   * Early reflections come from image sources against a shoebox roughly the
   * size of the underpass bay — those first 40 ms are what the ear actually
   * uses to judge "how big is this and how close are the walls", far more than
   * the tail is. The tail is then a diffuse noise decay with *frequency
   * dependent* decay times: highs die first, because air absorption and every
   * soft thing in the world (moss, vines, cypress) eat treble long before they
   * eat low mids. A tail with a flat decay is the single most recognisable
   * signature of a cheap reverb.
   */
  _buildReverb() {
    const ctx = this.ctx

    this._verbIn = ctx.createGain()
    this._verbIn.gain.value = 1

    const conv = ctx.createConvolver()
    conv.buffer = makeImpulseResponse(ctx, this._rand.bind(this))

    // Post-convolution tone control, driven by enclosure. Close hard surfaces
    // return bright early energy; a diffuse open-sky wash should be darker and
    // vaguer or it reads as a room that is not there.
    this._verbTone = ctx.createBiquadFilter()
    this._verbTone.type = 'lowpass'
    this._verbTone.frequency.value = 3800
    this._verbTone.Q.value = 0.5

    this._verbWet = ctx.createGain()
    this._verbWet.gain.value = 0.06

    this._verbIn.connect(conv).connect(this._verbTone).connect(this._verbWet)
    this._verbWet.connect(this.master)
  }

  // ------------------------------------------------------------ continuous

  /**
   * Wind rises with speed — the ambient readout of how fast you are going.
   *
   * Two bands, not one. The low band is the bed; the sizzle band only arrives
   * in the top third of the speed range, so the very fast part of a run has
   * somewhere left to go. That spectral change is most of what the ear reads
   * as "faster", and it lets the overall level stay low.
   */
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
    hp.frequency.value = 120      // below this it is rumble, not wind

    const gain = ctx.createGain()
    gain.gain.value = 0

    src.connect(lp).connect(hp).connect(gain).connect(this._ambDuck)
    src.start()

    // Gusting. Two slow, mutually prime rates so the modulation never settles
    // into an audible pulse; ±90 Hz on a cutoff that runs 380-2280 Hz is felt
    // as "the air is moving" and not heard as an effect.
    const gustA = ctx.createOscillator()
    gustA.frequency.value = 0.13
    const gustB = ctx.createOscillator()
    gustB.frequency.value = 0.29
    const gustDepth = ctx.createGain()
    gustDepth.gain.value = 90
    gustA.connect(gustDepth)
    gustB.connect(gustDepth)
    // AudioParam value = intrinsic automation + summed connections, so this
    // rides on top of the setTargetAtTime in update() rather than fighting it.
    gustDepth.connect(lp.frequency)
    gustA.start()
    gustB.start()

    // The high band: a separate, much quieter hiss that only opens up fast.
    const sizzle = ctx.createBiquadFilter()
    sizzle.type = 'bandpass'
    sizzle.frequency.value = 4200
    sizzle.Q.value = 0.8
    const sizzleGain = ctx.createGain()
    sizzleGain.gain.value = 0
    src.connect(sizzle).connect(sizzleGain).connect(this._ambDuck)

    this._wind = lp
    this._windGain = gain
    this._windSizzle = sizzleGain
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

    src.connect(bp).connect(gain).connect(this._ambDuck)
    src.start()
    this._scrape = bp
    this._scrapeGain = gain
  }

  /**
   * The clockwork layer's continuous half: the courier's own mainspring and
   * gear train, whirring faster the harder they are working.
   *
   * This is deliberately below the threshold at which you would call it a
   * sound effect. It should register as "this body is a machine" and never as
   * "there is a whirring noise". The amplitude modulation is what sells it —
   * a steady band of noise is a fan, a *fluttering* one is a gear train, and
   * the flutter rate riding on speed is the whole trick.
   */
  _buildGearbox() {
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this._noise
    src.loop = true

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 880      // small brass gears, not a factory
    bp.Q.value = 4.5

    const gain = ctx.createGain()
    gain.gain.value = 0

    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'         // sawtooth would read as a rattle, not teeth
    lfo.frequency.value = 6
    const depth = ctx.createGain()
    depth.gain.value = 0
    lfo.connect(depth).connect(gain.gain)
    lfo.start()

    src.connect(bp).connect(gain).connect(this._ambDuck)
    src.start()

    this._gearGain = gain
    this._gearLfo = lfo
    this._gearDepth = depth
  }

  // ----------------------------------------------------------------- update

  /**
   * Called every frame with the live player state.
   *
   * `refSpeed` is the speed at which wind reaches full volume, and it must be
   * near the TOP of the achievable range, not at sprint speed. Normalising
   * against sprint meant the wind pinned at maximum the instant you hit ~40
   * km/h and then sounded identical at 60, 80 and 120 — the exact speeds
   * where the player most wants to hear that they are going faster. Ethan's
   * report was "the wooshing sound is a bit over the top"; do not undo this.
   *
   * Allocates nothing. Everything here is scalar arithmetic over preallocated
   * state plus native AudioParam calls.
   */
  update(player, refSpeed) {
    if (!this.ready || !player) return
    try {
      this._player = player
      const t = this.ctx.currentTime

      // Below this there is no wind at all: walking around should be quiet.
      const FLOOR = 7.0
      const span = refSpeed - FLOOR
      const s = span > 0.01
        ? Math.min(1, Math.max(0, (player.speed3d - FLOOR) / span))
        : 0

      this._probeSpace(player)
      const enc = this._enclosure

      // Gentle curve and a low ceiling. Wind is a bed under the mix, not an
      // event — it was drowning the footsteps and landings that actually carry
      // information. Enclosure pulls it down further: under the underpass the
      // sky is not blowing on you, and that contrast is free spatial telling.
      const shelter = 1 - enc * 0.45
      const windTarget = (Math.pow(s, 1.7) * 0.15 + (player.grounded ? 0 : 0.012)) * shelter
      this._windGain.gain.setTargetAtTime(windTarget, t, 0.14)
      // Sizzle is gated by s^4, so it is inaudible until roughly the top third
      // of the range and then arrives quickly. Peak 0.035 — a seasoning.
      this._windSizzle.gain.setTargetAtTime(Math.pow(s, 4) * 0.035 * shelter, t, 0.2)
      // Open the filter with speed too, so it brightens as well as swells —
      // that spectral change is most of what the ear reads as "faster".
      this._wind.frequency.setTargetAtTime(380 + s * 1900, t, 0.2)

      const scrapeTarget = player.wallRunning ? 0.04 + s * 0.07 : 0
      this._scrapeGain.gain.setTargetAtTime(scrapeTarget, t, 0.05)
      this._scrape.frequency.setTargetAtTime(1800 + s * 2200, t, 0.1)

      // Gear train: only while the legs are doing work. Airborne it idles,
      // because a wind-up mechanism free-wheels when it is not driving
      // anything, and the drop in the whir as you leave the ground is a
      // surprisingly strong "you are airborne now" cue for how quiet it is.
      const drive = player.grounded ? Math.min(1, player.speed / 12) : 0.12
      const gearBase = 0.004 + drive * 0.013
      this._gearGain.gain.setTargetAtTime(gearBase, t, 0.09)
      // Modulation depth is 70% of the base level: deep enough to flutter,
      // shallow enough that the gain can never be driven negative.
      this._gearDepth.gain.setTargetAtTime(gearBase * 0.7, t, 0.09)
      // 5 Hz idle to 26 Hz at a sprint. Above ~30 Hz AM stops reading as teeth
      // passing and starts reading as a buzzy sideband, so this is capped by
      // the speed normalisation rather than by the raw speed.
      this._gearLfo.frequency.setTargetAtTime(5 + drive * 21, t, 0.12)

      // Room: send scales with enclosure, and the return brightens with it.
      // Open sky keeps a token 0.05 so cues do not sound anechoic and pasted
      // on; a tight bay reaches 0.5, which is obvious without being a cave.
      this._verbWet.gain.setTargetAtTime(0.05 + enc * 0.45, t, 0.35)
      this._verbTone.frequency.setTargetAtTime(2200 + enc * 5200, t, 0.35)
    } catch (err) {
      /* never throw at a caller that does not check */
    }
  }

  /**
   * Probe the collision world for how enclosed the player is.
   *
   * One ray per frame from a fixed nine-direction table, kept in a running
   * array — a full refresh every 9 frames (~7 Hz), which is far faster than
   * the 0.35 s smoothing on the wet gain can respond to anyway. Casting all
   * nine every frame would be nine times the cost for no audible benefit.
   *
   * Cheap and approximate on purpose: this decides a reverb send, not a
   * gameplay outcome. Being wrong for 150 ms after you sprint into a tunnel is
   * not a bug, it is roughly how ears work.
   */
  _probeSpace(player) {
    const world = player.world
    const boxes = world && world.boxes
    if (!boxes || boxes.length === 0) return
    this._boxes = boxes

    const i = this._probeCursor
    this._probeCursor = (i + 1) % PROBE_COUNT
    const b = i * 3

    // Ear height, not foot height: probing from the feet finds the floor with
    // every diagonal and reports a cupboard wherever you stand.
    const ox = player.position.x
    const oy = player.position.y + 1.5
    const oz = player.position.z
    this._probeHits[i] = this._rayDistance(
      ox, oy, oz, PROBE_DIRS[b], PROBE_DIRS[b + 1], PROBE_DIRS[b + 2],
    )

    let sum = 0
    let weight = 0
    for (let k = 0; k < PROBE_COUNT; k++) {
      // The last entry is straight up, and a ceiling is worth more than any
      // one wall for judging enclosure — an alley is not a tunnel.
      const w = k === PROBE_COUNT - 1 ? 3 : 1
      sum += (1 - this._probeHits[k] / PROBE_RANGE) * w
      weight += w
    }
    // Bent upward (x^1.5) so a couple of walls at middle distance — an open
    // terrace with a parapet — do not read as "enclosed", while a genuine
    // tunnel still gets somewhere near the top of the range. Squaring it was
    // measurably too pessimistic: a corridor with a 4.5 m ceiling came out at
    // 0.26, which is barely more room than open sky.
    const raw = sum / weight
    this._enclosure = raw * Math.sqrt(raw)
  }

  /**
   * Distance to the nearest AABB along a ray, clamped to PROBE_RANGE.
   *
   * Textbook slab test, written out scalar rather than with vectors because it
   * runs over every box in the level and must not allocate. Boxes are
   * `{min, max}` THREE.Vector3 pairs owned by CollisionWorld — read only.
   */
  _rayDistance(ox, oy, oz, dx, dy, dz, max = PROBE_RANGE) {
    const boxes = this._boxes
    // Reciprocals hoisted out of the loop; ±Infinity for an axis-aligned zero
    // component is exactly right for the slab test and is handled below.
    const ix = dx !== 0 ? 1 / dx : Infinity
    const iy = dy !== 0 ? 1 / dy : Infinity
    const iz = dz !== 0 ? 1 / dz : Infinity
    let best = max

    for (let n = 0; n < boxes.length; n++) {
      const box = boxes[n]
      const mn = box.min, mx = box.max

      // Broad reject: anything entirely outside the probe sphere cannot be
      // the nearest hit, and this is the branch that keeps the scan cheap on
      // a level with hundreds of colliders.
      if (mn.x - ox > best || ox - mx.x > best) continue
      if (mn.y - oy > best || oy - mx.y > best) continue
      if (mn.z - oz > best || oz - mx.z > best) continue

      let t0 = 0, t1 = best

      if (dx !== 0) {
        let a = (mn.x - ox) * ix, c = (mx.x - ox) * ix
        if (a > c) { const s = a; a = c; c = s }
        if (a > t0) t0 = a
        if (c < t1) t1 = c
      } else if (ox < mn.x || ox > mx.x) continue

      if (dy !== 0) {
        let a = (mn.y - oy) * iy, c = (mx.y - oy) * iy
        if (a > c) { const s = a; a = c; c = s }
        if (a > t0) t0 = a
        if (c < t1) t1 = c
      } else if (oy < mn.y || oy > mx.y) continue

      if (dz !== 0) {
        let a = (mn.z - oz) * iz, c = (mx.z - oz) * iz
        if (a > c) { const s = a; a = c; c = s }
        if (a > t0) t0 = a
        if (c < t1) t1 = c
      } else if (oz < mn.z || oz > mx.z) continue

      // t0 > 0.15 rejects the degenerate "origin is inside a collider" case,
      // which would otherwise report zero distance and slam the reverb wide
      // open the moment a mantle briefly parks the capsule inside a lip.
      if (t0 <= t1 && t0 > 0.15 && t0 < best) best = t0
    }
    return best
  }

  // -------------------------------------------------------------- surfaces

  /**
   * Which material is the player standing on?
   *
   * The contact tag is not published on the player or on its events — the
   * collision world carries it on every box (`level.js` passes its material
   * `kind` straight through as the tag) — so this finds the box the feet are
   * resting on and reads it off. Nearest top surface within a boot's height of
   * the feet, whose footprint contains them.
   */
  _surfaceUnder(player) {
    const t = this.ctx.currentTime
    if (t - this._surfAt < this._surfInterval) return this._surf
    this._surfAt = t

    const boxes = player.world && player.world.boxes
    if (!boxes) return this._surf

    const px = player.position.x
    const py = player.position.y
    const pz = player.position.z
    // The capsule radius is 0.34; 0.45 is that plus a little slack, because a
    // foot planted right on the lip of a platform should still hear the
    // platform rather than whatever is one metre below it.
    const R = 0.45

    let bestTop = -Infinity
    let bestTag = null
    for (let n = 0; n < boxes.length; n++) {
      const box = boxes[n]
      const mn = box.min, mx = box.max
      if (px < mn.x - R || px > mx.x + R) continue
      if (pz < mn.z - R || pz > mx.z + R) continue
      // Feet within 35 cm of this box's top face: above it, or a hair inside
      // it after the collision solver's push-out.
      const d = py - mx.y
      if (d > 0.35 || d < -0.20) continue
      if (mx.y > bestTop) { bestTop = mx.y; bestTag = box.tag }
    }

    if (bestTag != null) this._surf = this._profileFor(bestTag)
    return this._surf
  }

  /**
   * The material of whatever wall is within arm's reach, for wall contact
   * cues. Falls back to brass, which is both the most common runnable surface
   * and the most flattering thing to be wrong about in this world.
   */
  _surfaceBeside(player) {
    const boxes = player.world && player.world.boxes
    if (!boxes) return SURFACES.brass

    const px = player.position.x
    const py = player.position.y + 0.9    // mid-torso, not feet
    const pz = player.position.z
    // Wall-running holds the player a stand-off distance from the surface
    // (TUNING.wallReach is 0.55), so the search has to reach past the capsule.
    const R = 1.0

    let bestD = Infinity
    let bestTag = null
    for (let n = 0; n < boxes.length; n++) {
      const box = boxes[n]
      const mn = box.min, mx = box.max
      if (py < mn.y - 0.4 || py > mx.y + 0.4) continue
      const dx = px < mn.x ? mn.x - px : px > mx.x ? px - mx.x : 0
      const dz = pz < mn.z ? mn.z - pz : pz > mx.z ? pz - mx.z : 0
      if (dx > R || dz > R) continue
      const d = dx * dx + dz * dz
      if (d < bestD) { bestD = d; bestTag = box.tag }
    }
    return bestTag != null ? this._profileFor(bestTag) : SURFACES.brass
  }

  /** Tag → acoustic profile, memoised. Unknown tags resolve by substring. */
  _profileFor(tag) {
    if (!tag) return SURFACES.stone
    const cached = this._tagCache.get(tag)
    if (cached) return cached
    let hit = SURFACES[tag]
    if (!hit) {
      const lower = String(tag).toLowerCase()
      for (let i = 0; i < SURFACE_ALIASES.length; i++) {
        if (lower.indexOf(SURFACE_ALIASES[i][0]) !== -1) {
          hit = SURFACES[SURFACE_ALIASES[i][1]]
          break
        }
      }
    }
    if (!hit) hit = SURFACES.stone
    this._tagCache.set(tag, hit)
    return hit
  }

  // ---------------------------------------------------------------- events

  /**
   * `player.events` is drained here every sim step. Indexed loop rather than
   * for..of: this runs 60+ times a second with an almost always empty array,
   * and an iterator object per call is exactly the kind of garbage that shows
   * up as a stutter twenty minutes into a run.
   *
   * `player` is optional and main.js does not pass it — the surface-aware cues
   * need the collision world, so we fall back to the reference `update()`
   * cached last frame. It is the same live object, so the only cost of not
   * being handed it is that the very first sim step of a session uses the
   * default surface. Not worth a signature change at the call site for.
   */
  handle(events, player) {
    if (!this.ready || !events) return
    player = player || this._player
    try {
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        switch (e.type) {
          case 'step': this.step(e.speed, player); break
          case 'jump': this.jump(player); break
          case 'land': this.land(e.impact, player); break
          case 'vault': this.vault(player); break
          case 'wallrun': this.wallrun(player); break
          case 'walljump': this.walljump(player); break
          case 'slide': this.slide(player); break
          case 'dash': this.dash(); break
          case 'airjump': this.airjump(); break
          case 'grapple': this.grapple(); break
          case 'grapplerelease': this.grappleRelease(); break
          case 'climb': this.climb(player); break
        }
      }
    } catch (err) {
      /* a bad event must never break the frame */
    }
  }

  /**
   * A boot on whatever the courier is actually standing on.
   *
   * Transient, body, texture, plus — every few steps — a clockwork tick. The
   * round-robin table is what stops a sprint sounding like a looping sample:
   * six timbres cycled with a random 1-2 advance, plus per-step pitch and
   * level jitter, means the same footfall never lands twice in a row.
   */
  step(speed, player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceUnder(player) : this._surf
    const v = Math.min(1, 0.24 + speed / 40) * surf.damp
    const rr = STEP_RR[this._next('step', STEP_RR.length)]
    const jitter = 0.92 + this._rand() * 0.16
    const bus = this._buses.step

    // 1. transient — the leading edge of the contact. On moss this is a
    //    lowpass, so there is no bright edge at all; that inversion is most of
    //    what makes moss read as soft.
    this._noiseBurst({
      dur: 0.03, type: surf.tType, freq: surf.tFreq * jitter, q: 0.8,
      gain: v * 0.15 * surf.tGain * rr.bright, decay: surf.tDecay, dest: bus,
    })
    // 2. body — the player's mass arriving.
    this._tone({
      freq: surf.bodyHz * rr.body * jitter,
      to: surf.bodyHz * rr.body * surf.bodyTo * jitter,
      type: 'sine', dur: surf.bodyDur, gain: v * 0.17, dest: bus,
    })
    // 3. texture — the surface itself.
    this._noiseBurst({
      dur: 0.075, type: 'bandpass', freq: surf.texHz * rr.tex * jitter, q: surf.texQ,
      gain: v * 0.21 * surf.texGain * rr.bright, decay: surf.texDecay, dest: bus,
    })
    // 4. ring — only materials that ring get one, and a footstep only excites
    //    it faintly. This is what makes a brass walkway audibly different from
    //    the sandstone either side of it.
    if (surf.ring > 0) {
      this._ring({
        freq: surf.ringHz * jitter, gain: v * 0.045 * surf.ring,
        dur: 0.16 + surf.ring * 0.2, partials: 2, dest: bus,
      })
    }

    // The clockwork layer, tied to movement: an escapement tick every third
    // footfall. Any more often and it becomes a rhythm section; this way it
    // reads as the mechanism keeping time somewhere inside the courier.
    if (this._rr.step % 3 === 0) this._tick(v)
  }

  /**
   * Landing: the same stack as a footstep, but the proportions invert with
   * impact. A gentle landing is mostly texture; a hard one is mostly body,
   * with a debris tail that only appears once the impact is genuinely heavy —
   * that threshold is what makes a big drop feel different in kind rather than
   * just louder. Hard landings also duck the ambience, because this is the
   * single most information-dense cue in the game.
   */
  land(impact, player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceUnder(player) : this._surf
    const rr = LAND_RR[this._next('land', LAND_RR.length)]
    const g = (0.20 + impact * 0.42) * surf.damp
    const jitter = 0.94 + this._rand() * 0.12
    const bus = this._buses.impact
    const t = this.ctx.currentTime

    this._noiseBurst({
      dur: 0.03, type: surf.tType, freq: surf.tFreq * 0.88 * jitter, q: 0.8,
      gain: g * 0.22 * surf.tGain * rr.bright, decay: surf.tDecay, dest: bus,
    })
    // Body pitch falls with impact: a heavy arrival excites lower modes of the
    // same structure, which is why a big drop sounds like a bigger object even
    // though the courier's mass never changes.
    this._tone({
      freq: (surf.bodyHz * 1.7 - impact * 30) * rr.body * jitter,
      to: (surf.bodyHz * 0.6 - impact * 8) * rr.body * jitter,
      type: 'sine', dur: 0.2 + impact * 0.18, gain: g, dest: bus,
    })
    this._noiseBurst({
      dur: 0.17, type: 'lowpass',
      freq: (surf.texHz * 0.5 + impact * 900) * rr.tex * jitter,
      gain: g * 0.60 * surf.texGain, decay: 0.13, dest: bus,
    })
    if (surf.ring > 0) {
      // Brass decking under a hard landing is the loudest legitimate ring in
      // the game, and it scales with impact so a drop onto a walkway is a
      // genuinely different event from stepping onto one.
      this._ring({
        freq: surf.ringHz * 0.8 * jitter, gain: g * 0.16 * surf.ring,
        dur: 0.3 + impact * 0.5, partials: 3, dest: bus,
      })
    }
    if (impact > 0.45 && surf.debris > 0) {
      // Debris: loose grit skittering after a hard arrival. Delayed 45 ms so
      // it is heard as a consequence of the impact rather than as part of it.
      this._noiseBurst({
        dur: 0.34, type: 'bandpass', freq: surf.texHz * 1.7, q: 1.1,
        gain: (impact - 0.45) * 0.30 * surf.debris * rr.debris,
        decay: 0.3, at: t + 0.045, dest: bus,
      })
    }
    // Duck proportionally: a scuff on landing should not silence the world,
    // a 12 m drop should. Capped at 0.5 so the bed never fully disappears —
    // a hole in the ambience is more noticeable than the duck it enables.
    this._duck(Math.min(0.5, 0.12 + impact * 0.45))
  }

  /** Ground jump: the spring unloading, and the courier leaving the surface. */
  jump(player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceUnder(player) : this._surf
    this._tone({ freq: 220, to: 380, type: 'triangle', dur: 0.16, gain: 0.15, dest: this._buses.air })
    this._noiseBurst({ dur: 0.14, type: 'highpass', freq: 900, gain: 0.09, decay: 0.12, dest: this._buses.air })
    // The push-off scuff belongs to the surface, not to the jump.
    this._noiseBurst({
      dur: 0.06, type: 'bandpass', freq: surf.texHz * 1.1, q: surf.texQ,
      gain: 0.10 * surf.texGain * surf.damp, decay: 0.05, dest: this._buses.step,
    })
    // A wound spring letting go — the quietest member of the clockwork family.
    this._tone({ freq: 1900, to: 1200, type: 'square', dur: 0.03, gain: 0.018, dest: this._buses.mech })
  }

  /**
   * Vault: a hand slapping stone, then a push off it, then the scuff of the
   * boot dragging over the lip. Three moments in 130 ms.
   */
  vault(player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceBeside(player) : this._surf
    const rr = VAULT_RR[this._next('vault', VAULT_RR.length)]
    const jitter = 0.93 + this._rand() * 0.14
    const bus = this._buses.impact
    const t = this.ctx.currentTime

    // Palm on stone: broad, dull, no high edge — skin is not a boot.
    this._noiseBurst({
      dur: 0.1, type: 'bandpass', freq: 900 * rr.slap * jitter, q: 1.1,
      gain: 0.24 * rr.slap * surf.damp, decay: 0.08, dest: bus,
    })
    this._tone({
      freq: 160 * rr.push * jitter, to: 250 * rr.push * jitter,
      type: 'triangle', dur: 0.13, gain: 0.13 * rr.push, dest: bus,
    })
    // The scuff over the top, offset so the ear reads it as a second contact.
    this._noiseBurst({
      dur: 0.13, type: 'bandpass', freq: surf.texHz * 1.3 * rr.scuff, q: surf.texQ * 0.8,
      gain: 0.11 * rr.scuff * surf.texGain, decay: 0.1, at: t + 0.055, dest: this._buses.step,
    })
    if (surf.ring > 0) {
      this._ring({ freq: surf.ringHz * 1.3 * jitter, gain: 0.05 * surf.ring, dur: 0.24, partials: 2, dest: bus })
    }
    this._duck(0.16)
  }

  /** Attaching to a wall: contact, then the material answering. */
  wallrun(player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceBeside(player) : SURFACES.brass
    const jitter = 0.94 + this._rand() * 0.12
    const bus = this._buses.impact
    this._noiseBurst({
      dur: 0.2, type: 'bandpass', freq: surf.texHz * 1.5 * jitter, q: 2.6,
      gain: 0.18 * surf.texGain, decay: 0.16, dest: bus,
    })
    if (surf.ring > 0) {
      // Metal resonance on wall contact: a brass panel struck a glancing blow
      // rings quietly and briefly. This is the cue that tells you the wall you
      // just caught is a *brass* wall, which in this world's language means it
      // is a surface the level intends you to use.
      this._ring({
        freq: surf.ringHz * 1.6 * jitter, gain: 0.055 * surf.ring,
        dur: 0.42, partials: 3, dest: bus,
      })
    }
    this._duck(0.14)
  }

  /**
   * Wall-jump: the most metallic cue in the game — a struck panel, kicked off.
   * It is also the most important one to hear over the wind, which is why it
   * lives on the impact bus with a full duck behind it.
   */
  walljump(player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceBeside(player) : SURFACES.brass
    const rr = WALLJUMP_RR[this._next('walljump', WALLJUMP_RR.length)]
    const jitter = 0.95 + this._rand() * 0.1
    const bus = this._buses.impact

    // The kick: the courier's own effort, below the panel it is applied to.
    this._tone({
      freq: 340 * rr.kick * jitter, to: 240 * rr.kick * jitter,
      type: 'square', dur: 0.16, gain: 0.085, dest: bus,
    })
    this._noiseBurst({
      dur: 0.14, type: 'bandpass', freq: surf.texHz * 0.85 * rr.tex * jitter, q: 2.0,
      gain: 0.19 * surf.texGain * surf.damp, decay: 0.11, dest: bus,
    })
    this._ring({
      freq: (surf.ring > 0 ? surf.ringHz : 690) * rr.ring * jitter,
      gain: 0.10 * (0.5 + surf.ring * 0.5), dur: 0.34, partials: 3, dest: bus,
    })
    this._duck(0.22)
  }

  /** Vertical wall-run: boots scrabbling upward, rising in pitch. */
  climb(player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceBeside(player) : SURFACES.brass
    const jitter = 0.94 + this._rand() * 0.12
    // Four scuffs rather than one continuous hiss: a climb is *steps*, and
    // hearing them individually is what makes it read as effort rather than
    // as a slide with the pitch envelope of a climb.
    const t = this.ctx.currentTime
    for (let i = 0; i < 4; i++) {
      const k = i / 3
      this._noiseBurst({
        dur: 0.1, type: 'bandpass', freq: surf.texHz * (0.8 + k * 0.9) * jitter,
        q: 1.8, gain: (0.15 - k * 0.03) * surf.texGain, decay: 0.07,
        at: t + i * 0.085, dest: this._buses.step,
      })
    }
    this._tone({ freq: 190, to: 430, type: 'triangle', dur: 0.3, gain: 0.10, dest: this._buses.air })
    // Ratchet: the cape mechanism paying out line as the courier goes up.
    this._ratchet(3, 0.032, 0.022, t + 0.03)
  }

  /**
   * Dash: a sharp intake of air, pitched up. Reads as effort first and
   * machinery second — the spring is there, but the air is the story.
   */
  dash() {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const rr = DASH_RR[this._next('dash', DASH_RR.length)]
    const jitter = 0.93 + this._rand() * 0.14
    const bus = this._buses.air
    const t = this.ctx.currentTime

    this._noiseBurst({
      dur: 0.22, type: 'bandpass', freq: 1700 * rr.whoosh * jitter, q: 0.9,
      gain: 0.28 * rr.air, decay: 0.17, dest: bus,
    })
    this._tone({
      freq: 300 * jitter, to: 720 * rr.whoosh * jitter,
      type: 'triangle', dur: 0.19, gain: 0.11, dest: bus,
    })
    // The mainspring dumping its charge: a fast detent burst under the air, so
    // the dash is legibly *powered* rather than a puff of wind.
    this._ratchet(4, 0.018, 0.03 * rr.spring, t)
    this._duck(0.18)
  }

  /** Air jump: the clockwork cape ratcheting open, then catching air. */
  airjump() {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const rr = AIRJUMP_RR[this._next('airjump', AIRJUMP_RR.length)]
    const jitter = 0.94 + this._rand() * 0.12
    const t = this.ctx.currentTime

    // Detents first — the cape does not snap, it *indexes* open. Five clicks
    // accelerating slightly is the difference between a ratchet and a rattle.
    this._ratchet(5, 0.021, 0.035 * rr.detent, t)
    this._noiseBurst({
      dur: 0.09, type: 'bandpass', freq: 3400 * jitter, q: 3.0,
      gain: 0.14, decay: 0.06, at: t + 0.02, dest: this._buses.mech,
    })
    // Then the canopy filling: the loud, low, satisfying part.
    this._noiseBurst({
      dur: 0.3, type: 'lowpass', freq: 800 * jitter,
      gain: 0.24 * rr.canopy, decay: 0.24, at: t + 0.03, dest: this._buses.air,
    })
    this._tone({
      freq: 240 * jitter, to: 460 * rr.lift * jitter,
      type: 'triangle', dur: 0.22, gain: 0.12, at: t + 0.03, dest: this._buses.air,
    })
    this._duck(0.2)
  }

  /**
   * Grapple fire: the cuff's spring releasing, the line paying out, then the
   * hook biting. Three distinct moments, scheduled rather than stacked, so the
   * ear hears a mechanism operate instead of one undifferentiated clank. The
   * bite is on the impact bus — it is the moment the player needs to know
   * about, because everything they do next depends on it.
   */
  grapple() {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const rr = GRAPPLE_RR[this._next('grapple', GRAPPLE_RR.length)]
    const jitter = 0.95 + this._rand() * 0.1
    const t = this.ctx.currentTime

    // Spring release.
    this._tone({
      freq: 1400 * rr.spring * jitter, to: 700 * jitter, type: 'square',
      dur: 0.05, gain: 0.045, at: t, dest: this._buses.mech,
    })
    this._ratchet(3, 0.014, 0.026 * rr.spring, t)
    // Line paying out — a rising hiss that sweeps as the line extends.
    this._noiseBurst({
      dur: 0.16, type: 'bandpass', freq: 1600 * rr.line * jitter,
      sweepTo: 3000 * rr.line, q: 1.4, gain: 0.13, decay: 0.14,
      at: t + 0.01, dest: this._buses.air,
    })
    // The bite: brass on brass, 100 ms later, and it rings.
    this._noiseBurst({
      dur: 0.1, type: 'bandpass', freq: 3600 * rr.bite * jitter, q: 4.0,
      gain: 0.19, decay: 0.07, at: t + 0.1, dest: this._buses.impact,
    })
    this._ring({
      freq: 620 * rr.bite * jitter, gain: 0.10, dur: 0.36,
      partials: 3, at: t + 0.1, dest: this._buses.impact,
    })
    this._duck(0.24)
  }

  /** Release: the line detaching and whipping back into the cuff. */
  grappleRelease() {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const jitter = 0.94 + this._rand() * 0.12
    const t = this.ctx.currentTime
    this._noiseBurst({
      dur: 0.2, type: 'highpass', freq: 1800 * jitter, gain: 0.13,
      decay: 0.16, dest: this._buses.air,
    })
    this._tone({
      freq: 900 * jitter, to: 1500 * jitter, type: 'triangle',
      dur: 0.12, gain: 0.055, dest: this._buses.air,
    })
    // The cuff swallowing the line: a spool spinning down, then the latch.
    this._ratchet(4, 0.026, 0.022, t + 0.06)
    this._tone({ freq: 2400, to: 1800, type: 'square', dur: 0.02, gain: 0.03, at: t + 0.19, dest: this._buses.mech })
  }

  /** Slide: a long scrape whose material comes from what is under the hip. */
  slide(player) {
    // Public cue: `handle` already checks, but callers reach these directly too
    // and none of them check anything. Silence before init() beats a throw.
    if (!this.ready) return
    const surf = player ? this._surfaceUnder(player) : this._surf
    this._noiseBurst({
      dur: 0.5, type: 'bandpass', freq: surf.texHz * 0.8, q: 1.2,
      gain: 0.22 * surf.texGain * surf.damp, sweepTo: surf.texHz * 0.45,
      decay: 0.42, dest: this._buses.step,
    })
    // The entry thump — a slide starts with the body dropping onto the surface.
    this._tone({
      freq: surf.bodyHz * 0.9, to: surf.bodyHz * 0.6, type: 'sine',
      dur: 0.14, gain: 0.11 * surf.damp, dest: this._buses.impact,
    })
    this._duck(0.14)
  }

  /** Checkpoint: a small brass bell, struck once. */
  checkpoint() {
    if (!this.ready) return
    try {
      this._ring({ freq: 520, gain: 0.16, dur: 1.1, partials: 3, dest: this._buses.ui })
      this._duck(0.3)
    } catch (err) { /* never throw */ }
  }

  /** Finish: the same bell, as a chord, with the low octave under it. */
  finish() {
    if (!this.ready) return
    try {
      const t = this.ctx.currentTime
      const notes = [520, 660, 784]       // a major triad on the checkpoint bell
      const delays = [0, 0.09, 0.2]       // rolled, not struck together
      for (let i = 0; i < 3; i++) {
        this._ring({
          freq: notes[i], gain: 0.13, dur: 2.0, partials: 2,
          at: t + delays[i], dest: this._buses.ui,
        })
      }
      this._tone({ freq: 130, type: 'sine', dur: 2.4, gain: 0.14, at: t, attack: 0.02, dest: this._buses.ui })
      this._duck(0.35)
    } catch (err) { /* never throw */ }
  }

  // ------------------------------------------------------- clockwork layer

  /**
   * One escapement tick. Two very short, very quiet partials: a pallet landing
   * on an escape-wheel tooth is a click with a pitch, not a pure click.
   */
  _tick(level = 1) {
    const j = 0.96 + this._rand() * 0.08
    this._tone({ freq: 3100 * j, type: 'sine', dur: 0.012, gain: 0.016 * level, attack: 0.001, dest: this._buses.mech })
    this._tone({ freq: 4700 * j, type: 'sine', dur: 0.008, gain: 0.010 * level, attack: 0.001, dest: this._buses.mech })
  }

  /**
   * A ratchet: `n` detents `spacing` seconds apart, each quieter and slightly
   * higher than the last.
   *
   * Accelerating the spacing by 8% per click is what makes it read as a pawl
   * running down a wheel that is slowing; perfectly even clicks read as a
   * machine gun. Bounded by `n`, so this can never schedule an open-ended
   * stream of voices.
   */
  _ratchet(n, spacing, gain, at) {
    const t0 = at ?? this.ctx.currentTime
    let dt = 0
    for (let i = 0; i < n; i++) {
      const k = i / Math.max(1, n - 1)
      this._tone({
        freq: (2200 + k * 900) * (0.97 + this._rand() * 0.06),
        type: 'square',
        dur: 0.014,
        gain: gain * (1 - k * 0.55),
        attack: 0.001,
        at: t0 + dt,
        dest: this._buses.mech,
      })
      dt += spacing * (1 + i * 0.08)
    }
  }

  /**
   * Struck metal: an inharmonic partial series.
   *
   * 1 : 2.76 : 5.40 : 8.93 is the classic circular-plate mode ratio, and it is
   * the reason this reads as brass rather than as a synth bell — a harmonic
   * series here would sound like an organ. Higher partials are quieter and
   * decay faster, which is simply what happens in real metal: the small modes
   * radiate their energy away first.
   */
  _ring({ freq, gain = 0.1, dur = 0.3, partials = 3, at, dest }) {
    const ratios = RING_PARTIALS
    const n = Math.min(partials, ratios.length)
    for (let i = 0; i < n; i++) {
      // A few cents of detune per partial per strike, so two hits on the same
      // panel are never phase-identical.
      const detune = 0.995 + this._rand() * 0.01
      this._tone({
        freq: freq * ratios[i] * detune,
        type: 'sine',
        dur: dur / (1 + i * 0.55),
        gain: gain / (i + 1.4),
        attack: 0.003,
        at,
        dest,
      })
    }
  }

  // ------------------------------------------------------------------- mix

  /**
   * Pull the ambience down under an important transient and let it back up.
   *
   * The attack is 12 ms (fast enough that the cue arrives into a hole that is
   * already open) and the recovery is a 160 ms time constant (slow enough not
   * to be heard as a pump). Every call cancels the previous one, so rapid
   * events deepen the duck instead of fighting over the param.
   */
  _duck(depth) {
    const g = this._ambDuck.gain
    const t = this.ctx.currentTime
    const target = Math.max(0.3, 1 - depth)   // never fully mute the bed
    g.cancelScheduledValues(t)
    g.setValueAtTime(g.value, t)
    g.linearRampToValueAtTime(target, t + 0.012)
    g.setTargetAtTime(1, t + 0.02, 0.16)
  }

  /**
   * Voice admission. Returns false when the budget for this 100 ms window is
   * spent, and every primitive bails on false.
   *
   * Dropping voices is the right failure mode: past about eight simultaneous
   * cues nothing new is audible anyway, so the 61st voice in a window costs
   * CPU and adds only level. This is also the guarantee that no input pattern
   * can make this file allocate an unbounded number of nodes.
   */
  _voice() {
    const now = this.ctx.currentTime
    if (now - this._voiceWindow > VOICE_WINDOW) {
      this._voiceWindow = now
      this._voiceCount = 0
    }
    if (this._voiceCount >= VOICE_BUDGET) return false
    this._voiceCount++
    return true
  }

  // ----------------------------------------------------------- synth prims

  _tone({ freq, to, type = 'sine', dur = 0.2, gain = 0.2, at, attack = 0.005, dest }) {
    const ctx = this.ctx
    // Guard the whole primitive rather than trusting callers: freq of 0 or NaN
    // throws on setValueAtTime, and one bad multiplier upstream would
    // otherwise take out the frame.
    if (!(freq > 0) || !(gain > 0) || !(dur > 0)) return
    if (!this._voice()) return
    const g0 = Math.min(gain, VOICE_MAX_GAIN)
    const t0 = at ?? ctx.currentTime

    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    if (to != null && to > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur)

    const g = ctx.createGain()
    // Exponential ramps everywhere because gain is perceived logarithmically;
    // a linear decay audibly "hangs" at the end and then stops.
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(g0, t0 + Math.min(attack, dur * 0.5))
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(g).connect(dest || this._buses.impact)
    osc.start(t0)
    // +20 ms of slack so the stop never truncates the tail of the ramp.
    osc.stop(t0 + dur + 0.02)
  }

  _noiseBurst({ dur = 0.1, type = 'bandpass', freq = 1000, q = 1, gain = 0.2, decay = 0.08, at, dest, sweepTo }) {
    const ctx = this.ctx
    if (!(freq > 0) || !(gain > 0) || !(dur > 0)) return
    if (!this._voice()) return
    const g0 = Math.min(gain, VOICE_MAX_GAIN)
    const t0 = at ?? ctx.currentTime

    const src = ctx.createBufferSource()
    src.buffer = this._noise
    // Random offset into the buffer so repeated cues never phase-match — two
    // bursts starting at sample 0 correlate and sound like one louder burst.
    const offset = this._rand() * Math.max(0, this._noise.duration - dur - 0.05)

    const filt = ctx.createBiquadFilter()
    filt.type = type
    filt.frequency.setValueAtTime(freq, t0)
    // A swept band is what turns a hiss into a *movement* — a line paying out,
    // a slide bogging down.
    if (sweepTo != null && sweepTo > 0) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur)
    }
    filt.Q.value = q

    const g = ctx.createGain()
    g.gain.setValueAtTime(g0, t0)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.005, decay))

    src.connect(filt).connect(g).connect(dest || this._buses.impact)
    src.start(t0, offset, dur)
  }

  // ----------------------------------------------------------------- utils

  /** Advance a round-robin cursor by 1-2 so it never cycles predictably. */
  _next(key, n) {
    this._rr[key] += 1 + ((this._rand() * 2) | 0)
    return this._rr[key] % n
  }

  /**
   * xorshift32. Seeded and deterministic, which means a recorded input
   * sequence produces byte-identical audio — the only way to A/B a change to
   * this file without ears. Math.random would make every run different and
   * every comparison a matter of opinion.
   */
  _rand() {
    let x = this._seed
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    this._seed = x
    return x / 4294967296
  }
}

/** Circular-plate mode ratios — see `_ring`. */
const RING_PARTIALS = [1, 2.76, 5.40, 8.93]

/**
 * tanh soft clip over the input range [-1, 1].
 *
 * A WaveShaper clamps input outside [-1, 1] to the curve's end samples, so
 * this is a hard guarantee that the output magnitude never exceeds tanh(1) =
 * 0.762 regardless of how many voices arrive at once. Below about 0.3 — where
 * the mix normally lives — the curve is within 3% of unity gain, so it is
 * doing nothing audible in ordinary play.
 */
function makeSoftClipCurve() {
  const n = 2048
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(x)
  }
  return curve
}

function makeNoiseBuffer(ctx, seconds, rand) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  // Pink-ish noise (Voss-McCartney style running sum) — plain white noise is
  // too hissy to sit under a wind bed, and its energy is in the wrong place
  // for anything that is supposed to sound like a physical surface.
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < len; i++) {
    const w = rand() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.0990460
    b1 = 0.96300 * b1 + w * 0.2965164
    b2 = 0.57000 * b2 + w * 1.0526913
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.28
  }
  return buf
}

/**
 * Procedurally generated impulse response: early reflections from box image
 * sources, plus a diffuse tail with frequency-dependent decay.
 *
 * Modelled on the underpass bay, because that is the one enclosed space on the
 * course and therefore the only place where the room has to be *right* rather
 * than merely present. Everywhere else it is scaled down to near-nothing by
 * the wet send instead of being swapped for a second IR — one convolver, one
 * buffer, and the send does all the work.
 *
 * Image-source method, in one paragraph: a reflection off a flat wall is
 * acoustically identical to a straight line from a mirrored copy of the
 * source. Mirror the source across each of the six faces, then across pairs
 * and triples of faces for second- and third-order bounces, and the arrival
 * time of each copy is just its distance over the speed of sound. That gives
 * the first few dozen milliseconds their *pattern*, which is what the ear
 * uses to size a room — far more than the tail, which mostly says "how
 * reverberant" and not "how big".
 */
function makeImpulseResponse(ctx, rand) {
  const sr = ctx.sampleRate
  const dur = 1.9                     // longest tail we ever want, in seconds
  const len = Math.floor(sr * dur)
  const buf = ctx.createBuffer(2, len, sr)

  // Room dimensions in metres, and where the listener stands in it. Offset
  // from centre on purpose: a listener at the exact centre of a box gets
  // coincident image sources, which collapses the early pattern into a comb
  // filter and sounds like a metal pipe.
  const RW = 9.0, RH = 5.5, RD = 15.0
  const lx = RW * 0.42, ly = RH * 0.35, lz = RD * 0.4
  // Reflection coefficient per bounce. 0.62 is a hard-ish room — carved stone
  // and brass with moss and vines taking the edge off.
  const REFL = 0.62
  const ORDER = 3

  const L = buf.getChannelData(0)
  const R = buf.getChannelData(1)

  for (let ix = -ORDER; ix <= ORDER; ix++) {
    for (let iy = -ORDER; iy <= ORDER; iy++) {
      for (let iz = -ORDER; iz <= ORDER; iz++) {
        const order = Math.abs(ix) + Math.abs(iy) + Math.abs(iz)
        if (order === 0 || order > ORDER) continue

        // Mirrored source position for this image cell.
        const sx = ix % 2 === 0 ? lx + ix * RW : (ix + 1) * RW - lx
        const sy = iy % 2 === 0 ? ly + iy * RH : (iy + 1) * RH - ly
        const sz = iz % 2 === 0 ? lz + iz * RD : (iz + 1) * RD - lz

        const dx = sx - lx, dy = sy - ly, dz = sz - lz
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const i = Math.floor((dist / C_AIR) * sr)
        if (i <= 0 || i >= len) continue

        // 1/r spreading, referenced to 1 m, times the loss per bounce.
        const amp = (Math.pow(REFL, order) / Math.max(1, dist)) * 0.85
        // Alternating polarity by parity: real reflections off a wall of
        // finite impedance are not all in phase, and a same-sign spike train
        // sums into an audible "pling" at the top of the reverb.
        const sign = order % 2 === 0 ? 1 : -1
        // Inter-aural offset: a reflection arriving from the left of the room
        // hits the left channel a sample or two early. Crude, but it is what
        // stops the early field being dead mono.
        const pan = dx >= 0 ? 1 : -1
        const off = pan > 0 ? 1 : 0
        L[Math.min(len - 1, i + off)] += sign * amp * (pan > 0 ? 0.75 : 1)
        R[Math.min(len - 1, i + 1 - off)] += sign * amp * (pan > 0 ? 1 : 0.75)
      }
    }
  }

  // --- diffuse tail -------------------------------------------------------
  // Two decay times, because a real space does not decay uniformly: air
  // absorption and every soft surface in this world (moss, vines, cypress)
  // eat treble long before they eat low mids. Splitting the noise into a low
  // band and its complement and giving each its own RT60 is the cheapest
  // convincing way to get that, and its absence is the single most
  // recognisable signature of a bad synthetic reverb.
  const RT_LOW = 1.7          // seconds to -60 dB below ~1.2 kHz
  const RT_HIGH = 0.42        // ...and above it. Highs die first.
  // e^(-t/T) = 10^-3 at RT60, so T = RT60 / ln(1000).
  const TAU_LOW = RT_LOW / 6.9078
  const TAU_HIGH = RT_HIGH / 6.9078
  // One-pole split point: a = dt / (RC + dt) for a ~1.2 kHz corner.
  const A_LP = 1 - Math.exp(-2 * Math.PI * 1200 / sr)
  // The tail starts under the early reflections rather than after them, faded
  // in over 30 ms so there is no seam where one becomes the other.
  const FADE = Math.floor(sr * 0.03)

  let lpL = 0, lpR = 0
  for (let i = 0; i < len; i++) {
    const t = i / sr
    const envLow = Math.exp(-t / TAU_LOW)
    const envHigh = Math.exp(-t / TAU_HIGH)
    const fade = i < FADE ? i / FADE : 1

    const wl = rand() * 2 - 1
    const wr = rand() * 2 - 1
    lpL += A_LP * (wl - lpL)
    lpR += A_LP * (wr - lpR)

    // 0.5 keeps the tail well under the early reflections: reverb that is
    // louder than its own early field sounds like a plate, not a room.
    L[i] += (lpL * envLow + (wl - lpL) * envHigh) * 0.5 * fade
    R[i] += (lpR * envLow + (wr - lpR) * envHigh) * 0.5 * fade
  }

  // Peak-normalise so the wet gain in the graph means the same thing no
  // matter how the room parameters above are edited.
  let peak = 0
  for (let i = 0; i < len; i++) {
    const a = Math.abs(L[i]); if (a > peak) peak = a
    const b = Math.abs(R[i]); if (b > peak) peak = b
  }
  if (peak > 0) {
    const k = 0.9 / peak
    for (let i = 0; i < len; i++) { L[i] *= k; R[i] *= k }
  }
  return buf
}
