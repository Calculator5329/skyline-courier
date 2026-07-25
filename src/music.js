/**
 * Music playback.
 *
 * This is the one deliberate exception to the "no audio files" rule that
 * governs `src/audio.js`. That rule exists because *feedback* must be
 * synthesized — a footstep has to be generated from player state, and shipping
 * a hundred one-shots would be exactly the asset bloat this project refuses.
 * A score is a different kind of thing: it is authored once, it does not react
 * per-frame, and there is no synthesis technique that gets you a written
 * melody. So the score lives in `public/audio/` as four OGG files and
 * everything else stays procedural.
 *
 * The design constraint that shapes this whole file: `run` and `flow` are the
 * same piece of music at two intensities. They are the same key and the same
 * tempo, and their buffers are cut to *exactly* the same sample count, so if
 * both sources start on the same clock tick they stay bar-aligned forever.
 * `setIntensity` therefore only ever touches gain — it never starts, stops or
 * reseeks a source. That is the difference between the speed layer swelling in
 * underneath the player and the music visibly restarting when they hit a
 * sprint, which is the thing that would make it feel like a jukebox instead of
 * a score.
 *
 * OGG Vorbis, not MP3, and that is load-bearing: MP3 carries encoder delay and
 * padding that `decodeAudioData` turns into real silence at both ends of the
 * buffer, so `AudioBufferSourceNode.loop` produces an audible gap every pass.
 * Vorbis is sample-exact and loops seamlessly.
 *
 * Every public method is safe to call before (or instead of) a successful
 * load. Music is decoration; if the fetch 404s or the decode fails the game
 * gets quieter and nothing else changes. Callers never have to check a flag.
 */

const TRACKS = ['menu', 'run', 'flow', 'finish']

/** Gain ramp for track starts/stops. Long enough to not click, short enough
 *  to feel like a cue rather than a fade. */
const FADE = 0.6

/** Intensity crossfades are faster — this tracks player speed, and a slow ramp
 *  reads as the music lagging behind what the player is doing. */
const INTENSITY_FADE = 0.35

export class Music {
  /**
   * @param {AudioContext} ctx        the game's existing context
   * @param {AudioNode} destination   where music should land in the graph;
   *                                  pass the node SFX go through so music
   *                                  sits under the same master/compressor
   * @param {string} [basePath]       where the .ogg files live
   */
  constructor(ctx, destination, basePath) {
    this.ctx = ctx || null
    this.ready = false
    this.failed = false
    this.buffers = Object.create(null)

    // `import.meta.env.BASE_URL` keeps this correct under vite's `base: './'`
    // and under any future subdirectory deploy.
    let base = basePath
    if (!base) {
      let root = './'
      try {
        if (import.meta.env && import.meta.env.BASE_URL) root = import.meta.env.BASE_URL
      } catch (_) { /* non-vite host; relative is fine */ }
      base = root + 'audio/'
    }
    this.basePath = base

    // Current state, remembered so a play* call made before the buffers land
    // can be honoured once they do rather than silently dropped.
    this._pending = null
    this._mode = 'none'   // 'none' | 'menu' | 'gameplay' | 'finish'
    this._intensity = 0
    this._volume = 1

    this._sources = Object.create(null) // name -> AudioBufferSourceNode
    this._gains = Object.create(null)   // name -> GainNode

    if (!this.ctx) return
    try {
      this.master = this.ctx.createGain()
      this.master.gain.value = this._volume
      this.master.connect(destination || this.ctx.destination)
    } catch (_) {
      this.ctx = null
    }
  }

  /**
   * Fetch and decode everything. Safe to call more than once; the second call
   * returns the first call's promise. Never rejects — a failure just leaves
   * the instance permanently silent.
   *
   * @returns {Promise<boolean>} whether any track loaded
   */
  load() {
    if (this._loadPromise) return this._loadPromise
    if (!this.ctx) {
      this.failed = true
      this._loadPromise = Promise.resolve(false)
      return this._loadPromise
    }

    const one = async (name) => {
      try {
        const res = await fetch(this.basePath + name + '.ogg')
        if (!res.ok) throw new Error(res.status + ' ' + res.statusText)
        const bytes = await res.arrayBuffer()
        // Safari still wants the callback form, so wrap rather than assume
        // the promise overload exists.
        const buf = await new Promise((resolve, reject) => {
          const p = this.ctx.decodeAudioData(bytes, resolve, reject)
          if (p && typeof p.then === 'function') p.then(resolve, reject)
        })
        this.buffers[name] = buf
      } catch (err) {
        console.warn('[music] could not load "' + name + '":', err && err.message)
      }
    }

    this._loadPromise = Promise.all(TRACKS.map(one)).then(() => {
      const got = Object.keys(this.buffers).length
      this.ready = got > 0
      this.failed = got === 0
      if (this.ready && this._pending) {
        const p = this._pending
        this._pending = null
        // Replay whatever the caller asked for while we were still loading.
        if (p === 'menu') this.playMenu()
        else if (p === 'gameplay') this.playGameplay()
        else if (p === 'finish') this.playFinish()
      } else {
        this._pending = null
      }
      return this.ready
    })
    return this._loadPromise
  }

  // ------------------------------------------------------------- transport

  /** Title-screen bed. Loops. */
  playMenu() {
    if (!this._live()) { this._pending = 'menu'; return }
    if (this._mode === 'menu') return
    this._stopAll(FADE)
    this._mode = 'menu'
    this._start('menu', { loop: true, gain: 1, fade: FADE })
  }

  /**
   * Start the gameplay bed. Both `run` and `flow` start on the same tick and
   * stay running; only their gains move after this.
   */
  playGameplay() {
    if (!this._live()) { this._pending = 'gameplay'; return }
    if (this._mode === 'gameplay') return
    this._stopAll(FADE)
    this._mode = 'gameplay'

    // One shared start time for both layers. Scheduling slightly ahead of
    // `currentTime` means both `start()` calls land on the same sample frame
    // instead of on whenever each one happened to be executed.
    const t0 = this.ctx.currentTime + 0.02

    // Both files are cut to the same sample count, but `decodeAudioData` does
    // not necessarily hand them back that way: when the file's rate differs
    // from the context's, the browser resamples, and its handling of Vorbis
    // padding can leave the two buffers a few samples apart. A few samples per
    // pass is nothing on its own and everything cumulatively — the layers
    // would slide out of phase over a long session. Pinning both sources to
    // one explicit loopEnd makes the loop length identical by construction,
    // whatever the decoder did.
    // If only one layer decoded, that layer still plays on its own; the
    // crossfade just has nothing to fade to.
    const br = this.buffers.run, bf = this.buffers.flow
    const loopEnd = (br && bf) ? Math.min(br.duration, bf.duration)
                  : (br ? br.duration : (bf ? bf.duration : 0))
    if (!loopEnd) { this._mode = 'none'; return }

    const calm = Math.cos(this._intensity * Math.PI * 0.5)
    const fast = Math.sin(this._intensity * Math.PI * 0.5)
    this._start('run', { loop: true, gain: calm, fade: FADE, when: t0, loopEnd })
    this._start('flow', { loop: true, gain: fast, fade: FADE, when: t0, loopEnd })
  }

  /**
   * Crossfade between the calm and energised layers.
   * @param {number} t 0 = pure `run`, 1 = pure `flow`
   */
  setIntensity(t) {
    t = t > 1 ? 1 : t < 0 ? 0 : (typeof t === 'number' && t === t ? t : 0)
    this._intensity = t
    if (!this._live() || this._mode !== 'gameplay') return

    // Equal-power, not linear: two correlated layers summed linearly dip in
    // perceived loudness through the middle of the fade, and the dip is
    // exactly where the player is transitioning, so it is the most audible
    // place it could possibly be.
    const calm = Math.cos(t * Math.PI * 0.5)
    const fast = Math.sin(t * Math.PI * 0.5)
    this._ramp('run', calm, INTENSITY_FADE)
    this._ramp('flow', fast, INTENSITY_FADE)
  }

  /** One-shot route-complete stinger. Does not loop. */
  playFinish() {
    if (!this._live()) { this._pending = 'finish'; return }
    this._stopAll(0.9)
    this._mode = 'finish'
    this._start('finish', { loop: false, gain: 1, fade: 0.05 })
  }

  /** Stop everything. */
  stop(fade) {
    this._pending = null
    this._mode = 'none'
    if (!this._live()) return
    this._stopAll(fade == null ? FADE : fade)
  }

  /**
   * Master music level, independent of the crossfade.
   * @param {number} v 0..1
   */
  setVolume(v) {
    v = typeof v === 'number' && v === v ? (v < 0 ? 0 : v) : 0
    this._volume = v
    if (!this.ctx || !this.master) return
    try {
      const now = this.ctx.currentTime
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.linearRampToValueAtTime(v, now + 0.12)
    } catch (_) { /* no-op */ }
  }

  // -------------------------------------------------------------- internals

  /** True only when it is actually safe to touch the graph. */
  _live() {
    return !!(this.ctx && this.ready && this.master && !this.failed)
  }

  _start(name, opts) {
    const buf = this.buffers[name]
    if (!buf) return
    try {
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.loop = !!opts.loop
      if (opts.loop) {
        // Explicit loop points. The default would be the whole buffer, but
        // callers layering two tracks pass a shared loopEnd so both wrap at
        // exactly the same instant.
        src.loopStart = 0
        src.loopEnd = opts.loopEnd || buf.duration
      }

      const g = this.ctx.createGain()
      const when = opts.when != null ? opts.when : this.ctx.currentTime
      const target = opts.gain

      g.gain.setValueAtTime(0.0001, when)
      if (opts.fade > 0) {
        g.gain.linearRampToValueAtTime(target, when + opts.fade)
      } else {
        g.gain.setValueAtTime(target, when)
      }

      src.connect(g).connect(this.master)
      src.start(when)

      // A non-looping source disposes of itself so `finish` does not leak a
      // node per run.
      if (!opts.loop) {
        src.onended = () => {
          if (this._sources[name] === src) {
            delete this._sources[name]
            delete this._gains[name]
          }
          try { g.disconnect() } catch (_) { /* already gone */ }
        }
      }

      this._sources[name] = src
      this._gains[name] = g
    } catch (err) {
      console.warn('[music] could not start "' + name + '":', err && err.message)
    }
  }

  _ramp(name, value, time) {
    const g = this._gains[name]
    if (!g) return
    try {
      const now = this.ctx.currentTime
      g.gain.cancelScheduledValues(now)
      g.gain.setValueAtTime(g.gain.value, now)
      g.gain.linearRampToValueAtTime(value, now + time)
    } catch (_) { /* no-op */ }
  }

  _stopAll(fade) {
    const now = this.ctx.currentTime
    for (const name of Object.keys(this._sources)) {
      const src = this._sources[name]
      const g = this._gains[name]
      delete this._sources[name]
      delete this._gains[name]
      try {
        // Fade before stopping — cutting a gain node to zero instantaneously
        // is a click, and a click is the one thing a music system must never
        // produce.
        if (g && fade > 0) {
          g.gain.cancelScheduledValues(now)
          g.gain.setValueAtTime(g.gain.value, now)
          g.gain.linearRampToValueAtTime(0.0001, now + fade)
        }
        src.onended = null
        src.stop(now + (fade > 0 ? fade + 0.02 : 0))
        const dead = g
        if (dead) setTimeout(() => { try { dead.disconnect() } catch (_) {} }, (fade + 0.2) * 1000)
      } catch (_) { /* already stopped */ }
    }
  }
}
