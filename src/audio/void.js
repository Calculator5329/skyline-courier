/**
 * THE VOID'S CONTINUOUS AUDIO — the bed, the height, and the beams.
 *
 * Everything here is Web Audio synthesis. There are no SFX files in this repo
 * and there never will be (CLAUDE.md rule 1; the carve-out is `public/audio/`
 * music and it is not this file's business).
 *
 * ── why this file exists separately from audio.js ──────────────────────────
 *
 * `src/audio.js` is the game's sound *engine*: buses, surfaces, impacts,
 * reverb, the voice budget. It is theme-neutral by construction — every cue in
 * it takes its colour from a surface profile or a config number. This file is
 * the void's *content*: three continuous layers that only exist in a world made
 * of enclosed emptiness, plus the descriptor that retunes the engine for it.
 *
 * Keeping them apart is what makes "skyline must not regress" checkable rather
 * than hopeful: nothing in here is constructed at all unless the active theme
 * asks for it, so the shipped archipelago cannot be changed by an edit to this
 * file.
 *
 * ── the three layers, and what each one is FOR ─────────────────────────────
 *
 * Per docs/taste.md audio is feedback, not decoration. A dark level makes that
 * rule sharper rather than looser: in the void the ear is doing work the eye
 * cannot, so every one of these has a job you could fail the level for missing.
 *
 *   1. DRONE — "you are inside something, and it has no bottom."
 *      A sub-bass bed rather than a wind bed. Wind is weather, and weather
 *      needs sky; a cavern has air pressure instead. It is loudest and darkest
 *      at the floor of the shaft and thins as you climb, so the bed itself is a
 *      slow altimeter, and it swells when you are falling fast because a
 *      bottomless drop is the one thing the void can kill you with.
 *
 *   2. SHIMMER — "you are high up."
 *      A narrow band of very quiet noise near 6 kHz that only opens in the top
 *      half of the climb. High frequencies are the first thing a big space eats
 *      (see the frequency-dependent RT60 in audio.js), so hearing treble at all
 *      means the walls are far away — which up at hero-20 they are. It is the
 *      inverse of the drone by design: the two cross over around the middle of
 *      the course, so the spectral tilt of the bed IS the height readout.
 *
 *   3. BEAM HUM — "there is a landmark over there."
 *      `src/fx/voidfx.js` §2 calls the energy beams level design: "unmissable
 *      vertical landmarks in a course whose whole problem is that the player
 *      must read height". Unmissable, though, only while they are in frame. A
 *      hum that rises as you approach one makes a beam a landmark you can find
 *      with the camera pointing the wrong way, which in a near-black level is
 *      the difference between a landmark and a decoration.
 *
 * ── the shape of the hum ───────────────────────────────────────────────────
 *
 * Two sawtooths a hair apart, not one. A single oscillator is a test tone; two
 * detuned by ~1.5 Hz beat against each other, and that slow throb is the whole
 * difference between "a machine is running" and "there is a sine wave in my
 * game". The corona on top is band-passed noise with its own tremolo, because
 * an arc has a hiss and the hiss is what makes it read as ENERGY rather than as
 * a transformer.
 */

/** Where the shaft starts and stops, in metres. `levels/void.js` runs its
 *  spiral from y≈5 to y≈225 and hangs spurs below the line; the kill plane is
 *  at -140. These are the ends of the *audible* ramp, not of the level. */
const Y_FLOOR = -25
const Y_CEIL = 230

/**
 * THE THEME BLOCK. This is the object `src/theme.js` should hang on the void
 * under the key `audio`, and it is the whole audio half of the theme.
 *
 * It follows the same rule as `grade`, `exposure` and `aerial`: a PARTIAL
 * overlay whose absent keys fall through to the engine's shipped defaults, so
 * a theme states only what it changes and skyline states nothing at all.
 */
export const VOID_AUDIO = {
  /**
   * THE ROOM. These feed `makeImpulseResponse` in audio.js, which builds a
   * shoebox by the image-source method and then a frequency-dependent tail.
   *
   * The skyline's room is the underpass bay: 9 x 5.5 x 15 m, reflection 0.62,
   * RT60 1.7 s low / 0.42 s high. This is a SHAFT — as wide as a hero island's
   * crossing and a hundred metres tall — made of unweathered rock with nothing
   * soft in it. Three numbers carry that:
   *
   *   `height` 120 puts the first ceiling reflection 700 ms out instead of
   *     30 ms, which is why this reads as vast rather than merely reverberant.
   *     Early-reflection PATTERN is what the ear sizes a room with; the tail
   *     only says how live it is.
   *   `reflect` 0.88 is bare rock. There is no moss, no vine and no cypress in
   *     this world to eat the energy, and the archipelago's 0.62 assumed all
   *     three.
   *   `rtHigh` 1.25 against `rtLow` 4.8 keeps the ratio that makes a synthetic
   *     tail believable (highs die first) while moving both a long way out.
   *
   * `duration` has to be at least rtLow or the tail is truncated mid-decay,
   * which is audible as a gate. 4.6 s of stereo float at 48 kHz is ~1.8 MB,
   * built once at init.
   */
  room: {
    width: 44, height: 120, depth: 44,
    reflect: 0.88,
    rtLow: 4.8, rtHigh: 1.25,
    duration: 4.6,
  },

  /**
   * HOW MUCH OF THAT ROOM YOU HEAR, as a function of the enclosure probe.
   *
   * `floor` is the wet level with nothing around you. In the skyline that is
   * 0.05 — a token so cues are not anechoic — because open sky genuinely has no
   * room in it. In the void "nothing around you" means you are in the middle of
   * a cavern rather than outdoors, so the floor is six times higher and the
   * probe only adds the last part.
   *
   * `toneBase`/`toneRange` set the lowpass on the reverb return. Much darker
   * than the skyline's 2200 + 5200: bright reverb is small reverb, and a
   * violet cavern that returns 4 kHz sounds like a tiled bathroom.
   */
  verb: { floor: 0.30, range: 0.26, toneBase: 700, toneRange: 1900 },

  /**
   * THE MOVING-AIR LAYER, cut to a tenth.
   *
   * Not to zero. Falling 100 m past a rock face still moves air over your ears,
   * and at void speeds that rush is the only continuous cue that scales with
   * how fast you are actually going. But it is now MOTION noise rather than
   * WEATHER noise: much quieter, an octave down (`lowHz` 200 rather than 380,
   * `spanHz` 900 rather than 1900) and with the sizzle band all but gone,
   * because a bright hiss is what a breeze over a sunlit terrace sounds like.
   */
  wind: { bed: 0.038, sizzle: 0.006, airborne: 0.004, lowHz: 200, spanHz: 900 },

  /**
   * THE DRONE — layer 1 above. Off (absent) for any theme that does not ask.
   *
   * 24.5 Hz is under the fundamental of anything else in the mix and under most
   * of what a laptop speaker can reproduce, which is deliberate: on small
   * speakers you hear the 1.5x and 2x partials and the whole thing reads as a
   * low hum, and on anything with a woofer the room acquires a floor. The
   * partial set (1, 1.5, 2, 3) is a stack of fifths and octaves — no third, so
   * it has no mode and cannot fight whatever `music.js` is playing.
   */
  drone: {
    root: 24.5,
    partials: [1, 1.5, 2.0, 3.0],
    // Normalised to sum to ~1.0 so `gain` below means what it says. They summed
    // to 1.84 in the first version, which put the bed's PEAK at 0.21 — above
    // the -18 dBFS safety compressor in audio.js, so the drone was engaging it
    // continuously and every cue in the game arrived into a mix that was
    // already ducking. Measured, not noticed: `tools/voidaudio.mjs` prints the
    // peak of the bed on its own and that is why the number is now guarded.
    gains: [0.55, 0.23, 0.16, 0.07],
    // Peaks around 0.035 at the output, a third of the compressor's threshold.
    // High for a bed — the skyline's standing ambience measures 0.0005 — and
    // that is the point: this is the one theme where silence would be wrong.
    // It is also 25-75 Hz, where the ear is 40 dB less sensitive than it is at
    // the 1.5 kHz the archipelago's wind lives in, so the same RMS is a
    // fraction of the loudness.
    gain: 0.062,
    // Cutoff at the floor of the shaft and at the top of it. Climbing thins the
    // bed; it does not merely turn it down.
    cutoffLow: 88, cutoffHigh: 190,
    // Level at the floor vs at the ceiling. The void keeps a bed everywhere —
    // going quiet at altitude would read as the sound breaking.
    levelLow: 1.0, levelHigh: 0.58,
    // Breath: lowpassed noise under the oscillators, so the bed is not a chord.
    breath: 0.03, breathHz: 95,
    // The fall swell. `at` m/s of descent adds `gain` to the bed — a bottomless
    // drop is the void's only real threat and it should be felt in the chest.
    fallAt: 26, fallGain: 0.55,
  },

  /** THE SHIMMER — layer 2. Gated by `pow(height, 1.8)` so it is genuinely
   *  absent in the lower half rather than merely quiet there. */
  shimmer: { hz: 6100, q: 1.6, gain: 0.019, rateHz: 0.19, depth: 0.55 },

  /**
   * THE BEAM HUM — layer 3.
   *
   * `near` is the half-level distance: gain is `near / (near + d)`, so a beam
   * is at half strength 14 m out and still faintly there at 60. `range` is
   * where it is dropped entirely, and it is generous because the beams are
   * 470 m tall and you are as likely to meet one 80 m below its middle as
   * beside it.
   */
  beam: {
    hz: 118, detune: 1.6, gain: 0.075, near: 12, range: 95,
    coronaHz: 3200, coronaQ: 2.2, corona: 0.30, coronaRateHz: 3.7,
  },

  /**
   * THE RUNE ANSWERING A BOOT.
   *
   * `levels/void.js`: "a glowing rune means you may stand here — and it is the
   * ONLY such channel a near-black level has." That is a lot of weight for one
   * visual channel, and it fails exactly when the player is not looking at
   * their feet, which during a 30 m grapple crossing is always. So a landing in
   * the void gets a second channel: the inlay rings.
   *
   * Quiet, high, and short. It rides ON the landing rather than replacing any
   * of it, arriving 40 ms late so it reads as the slab answering rather than as
   * part of the impact. The pitch set is cycled so consecutive landings are not
   * the same note — three of them, no third between any pair, because a repeated
   * major triad is a jingle and this has to survive being heard 22 times.
   */
  rune: { notes: [1174.7, 1396.9, 1567.98], gain: 0.052, dur: 1.35, delay: 0.04, minImpact: 0.05 },

  /**
   * THE BELLS. Crystal, not brass.
   *
   * `ratios` replaces the circular-plate series in `_ring`. 1 : 2 : 3.01 : 5.02
   * is quasi-harmonic — a struck glass rod rather than a struck plate — and it
   * is the single cheapest way to move the checkpoint out of the archipelago's
   * material palette. The finish chord drops the major third for a fifth and an
   * octave: cold and open, the same interval set as the drone.
   */
  bells: {
    ratios: [1, 2.0, 3.01, 5.02],
    checkpointHz: 784, checkpointDur: 2.4,
    finish: [523.25, 784, 1046.5], finishDur: 4.0, finishSubHz: 87.3,
  },

  /**
   * PER-BUS OVERRIDES. Only the sends move: in a cavern the footfalls and the
   * air are IN the room, and hearing them dry is what makes a big space
   * collapse to a corridor. Trims are untouched — the mix rule that information
   * beats texture is not a theme decision.
   */
  buses: { step: { send: 0.80 }, air: { send: 0.45 }, mech: { send: 0.60 } },
}

/**
 * The three continuous void layers, as one object with one `update`.
 *
 * Constructed only when the theme asks for it. Allocates nothing after
 * construction: `update` runs every frame and is scalar arithmetic over
 * preallocated state plus native AudioParam calls, exactly like the rest of
 * the continuous layer in audio.js.
 */
export class VoidAmbience {
  /**
   * @param {BaseAudioContext} ctx
   * @param {object} cfg          the `drone`/`shimmer`/`beam` blocks above
   * @param {AudioNode} dest      the ambience bus (behind the duck)
   * @param {AudioBuffer} noise   audio.js's shared pink-noise buffer
   * @param {() => number} rand   audio.js's seeded PRNG
   * @param {Array} sites         `voidBeamSites()`, or [] to disable the hum
   */
  constructor(ctx, cfg, dest, noise, rand, sites) {
    this.ctx = ctx
    this.cfg = cfg
    this._sites = sites || []
    // Flat-packed so the per-frame nearest-beam search touches one typed array
    // rather than six objects. x, y (foot), z, height, intensity.
    this._beamData = new Float32Array(this._sites.length * 5)
    for (let i = 0; i < this._sites.length; i++) {
      const s = this._sites[i]
      const b = i * 5
      this._beamData[b] = s.x
      this._beamData[b + 1] = s.y
      this._beamData[b + 2] = s.z
      this._beamData[b + 3] = s.height || 100
      this._beamData[b + 4] = s.intensity != null ? s.intensity : 1
    }

    // Each layer is independent and optional: a future theme may want the
    // cavern bed without the beams, or the height shimmer on its own.
    if (cfg.drone) this._buildDrone(dest, noise, rand)
    if (cfg.shimmer) this._buildShimmer(dest, noise)
    if (cfg.beam && this._sites.length) this._buildBeam(dest, noise)
  }

  // ------------------------------------------------------------------ drone

  _buildDrone(dest, noise, rand) {
    const ctx = this.ctx
    const d = this.cfg.drone
    // Unity: the partial gains below are the mix, and `_droneMix` at the end
    // of the chain is the only thing `update` moves. (This node started life
    // at 0.0001 by copy-paste from the output gain, which measured as a drone
    // 80 dB down — inaudible, and invisible to anything but a render.)
    const sum = ctx.createGain()
    sum.gain.value = 1

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = d.cutoffLow
    // Deliberately shallow. A resonant peak on a bed this low is a boom that
    // one room in the world will amplify and every other will hide.
    lp.Q.value = 0.7

    this._droneOscs = []
    for (let i = 0; i < d.partials.length; i++) {
      const osc = ctx.createOscillator()
      // Sawtooth on the fundamental for weight, sine above it: a stack of saws
      // this low turns to mud the moment the reverb touches it.
      osc.type = i === 0 ? 'sawtooth' : 'sine'
      // A few cents off exact ratios, seeded, so the partials never phase-lock
      // into a single buzzing tone.
      osc.frequency.value = d.root * d.partials[i] * (0.998 + rand() * 0.004)
      const g = ctx.createGain()
      g.gain.value = d.gains[i]
      osc.connect(g).connect(sum)
      osc.start()
      this._droneOscs.push(osc)
    }

    // Breath: the air in the shaft, under the tone. Without it the drone is a
    // chord being held rather than a place being in.
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    const blp = ctx.createBiquadFilter()
    blp.type = 'lowpass'
    blp.frequency.value = d.breathHz
    const bg = ctx.createGain()
    bg.gain.value = d.breath
    src.connect(blp).connect(bg).connect(sum)
    src.start()

    // Two very slow, mutually prime rates on the cutoff, the same trick the
    // wind gusts use: the bed must never settle into an audible period.
    const a = ctx.createOscillator(); a.frequency.value = 0.037
    const b = ctx.createOscillator(); b.frequency.value = 0.083
    const depth = ctx.createGain(); depth.gain.value = 16
    a.connect(depth); b.connect(depth)
    // AudioParam value = intrinsic automation + summed connections, so this
    // rides on top of the setTargetAtTime in update() instead of fighting it.
    depth.connect(lp.frequency)
    a.start(); b.start()

    const out = ctx.createGain()
    out.gain.value = 0.0001
    sum.connect(lp).connect(out).connect(dest)

    this._droneMix = out
    this._droneLp = lp
  }

  _buildShimmer(dest, noise) {
    const ctx = this.ctx
    const s = this.cfg.shimmer
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true

    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = s.hz
    bp.Q.value = s.q

    const g = ctx.createGain()
    g.gain.value = 0.0001

    // Slow tremolo. Steady noise at 6 kHz is tape hiss; breathing noise at
    // 6 kHz is a space. The depth node is set from `update` so it can never
    // exceed the base level and drive the gain negative.
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = s.rateHz
    const depth = ctx.createGain()
    depth.gain.value = 0
    lfo.connect(depth).connect(g.gain)
    lfo.start()

    src.connect(bp).connect(g).connect(dest)
    src.start()

    this._shimmerGain = g
    this._shimmerDepth = depth
  }

  _buildBeam(dest, noise) {
    const ctx = this.ctx
    const b = this.cfg.beam
    const out = ctx.createGain()
    out.gain.value = 0.0001
    out.connect(dest)

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    lp.Q.value = 0.9
    lp.connect(out)

    this._beamOscs = []
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = b.hz + (i === 0 ? -b.detune / 2 : b.detune / 2)
      const g = ctx.createGain()
      g.gain.value = 0.5
      osc.connect(g).connect(lp)
      osc.start()
      this._beamOscs.push(osc)
    }

    // The corona: band-passed hiss with its own tremolo, which is what turns a
    // hum into an arc.
    const src = ctx.createBufferSource()
    src.buffer = noise
    src.loop = true
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = b.coronaHz
    bp.Q.value = b.coronaQ
    const cg = ctx.createGain()
    cg.gain.value = b.corona
    const lfo = ctx.createOscillator()
    lfo.type = 'triangle'
    lfo.frequency.value = b.coronaRateHz
    const depth = ctx.createGain()
    depth.gain.value = b.corona * 0.6
    lfo.connect(depth).connect(cg.gain)
    lfo.start()
    src.connect(bp).connect(cg).connect(out)
    src.start()

    this._beamOut = out
    this._beamLp = lp
  }

  // ----------------------------------------------------------------- update

  /**
   * @param {number} t   ctx.currentTime, passed in so every layer in a frame
   *                     agrees about when "now" is
   * @param {object} player  the live player (position, velocity, grounded)
   */
  update(t, player) {
    const y = player.position.y
    if (!this._droneMix) { this._updateHigh(t, player); return }
    const d = this.cfg.drone
    // Height, 0 at the floor of the shaft to 1 at the top of the climb.
    const h = clamp01((y - Y_FLOOR) / (Y_CEIL - Y_FLOOR))

    // Falling: only counted when actually airborne, so riding a lift or being
    // pushed down a slope does not swell the bed.
    const fall = player.grounded ? 0 : clamp01(-player.velocity.y / d.fallAt)

    const level = d.gain * (d.levelLow + (d.levelHigh - d.levelLow) * h)
      * (1 + fall * d.fallGain)
    // 0.5 s. The bed is a place, and a place does not change in a frame — this
    // is slow enough that a fast elevator ride reads as a transition rather
    // than as a fader move.
    this._droneMix.gain.setTargetAtTime(level, t, 0.5)
    this._droneLp.frequency.setTargetAtTime(
      d.cutoffLow + (d.cutoffHigh - d.cutoffLow) * h, t, 0.6)

    this._updateHigh(t, player)
  }

  /** The two layers that do not depend on the drone existing. */
  _updateHigh(t, player) {
    if (this._shimmerGain) {
      const s = this.cfg.shimmer
      const h = clamp01((player.position.y - Y_FLOOR) / (Y_CEIL - Y_FLOOR))
      // pow 1.8: genuinely absent below the middle of the course, rather than
      // present-but-quiet, so its arrival is information.
      const sg = Math.pow(h, 1.8) * s.gain
      this._shimmerGain.gain.setTargetAtTime(Math.max(0.00001, sg), t, 0.8)
      this._shimmerDepth.gain.setTargetAtTime(sg * s.depth, t, 0.8)
    }
    if (this._beamOut) this._updateBeam(t, player)
  }

  /**
   * Nearest energy beam, and how loud it therefore is.
   *
   * Distance is measured to the beam's AXIS horizontally, plus however far the
   * player is outside its vertical extent. A beam is a 470 m column, so the
   * horizontal term is nearly always the one that matters, and treating it as
   * a point source would silence a landmark you are standing right beside.
   */
  _updateBeam(t, player) {
    const b = this.cfg.beam
    const data = this._beamData
    const n = data.length / 5
    const px = player.position.x, py = player.position.y, pz = player.position.z

    let best = Infinity
    let bestI = 1
    for (let i = 0; i < n; i++) {
      const k = i * 5
      const dx = px - data[k], dz = pz - data[k + 2]
      const flat = Math.sqrt(dx * dx + dz * dz)
      const y0 = data[k + 1], y1 = y0 + data[k + 3]
      const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0
      const dist = Math.sqrt(flat * flat + dy * dy)
      if (dist < best) { best = dist; bestI = data[k + 4] }
    }

    let g = 0
    if (best < b.range) {
      // near / (near + d), tapered to zero at `range` so a beam does not click
      // out of existence at the edge of its audibility.
      g = b.gain * bestI * (b.near / (b.near + best)) * (1 - best / b.range)
    }
    this._beamOut.gain.setTargetAtTime(Math.max(0.00001, g), t, 0.35)
    // Close up it is bright and electrical; far away the cavern has already
    // eaten its top end, and matching that is what makes distance legible.
    const open = 700 + 2600 * clamp01(1 - best / 40)
    this._beamLp.frequency.setTargetAtTime(open, t, 0.4)
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
