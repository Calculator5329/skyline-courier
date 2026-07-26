#!/usr/bin/env node
/**
 * Void audio probe — does the void actually SOUND like a void?
 *
 *   node tools/voidaudio.mjs [--no-build] [--port 5233] [--verbose]
 *
 * WHY THIS EXISTS
 *
 * Audio has no visible output, which is exactly why it is easy to get wrong and
 * believe otherwise. `src/audio.js` swallows its own exceptions by design (a
 * thrown cue must never take a frame down), so "no console error" is evidence
 * of nothing at all, and a node-graph inspection cannot tell a node that is
 * connected from a node that is audible — a gain of 0.0001 passes both.
 *
 * So this RENDERS. `Audio.init` takes an optional context, and this hands it an
 * OfflineAudioContext, drives the shipped engine into a named game state, plays
 * the samples out, and measures them: RMS, peak, spectral centroid and four
 * band energies, plus the room's RT60 read straight off the convolver's own
 * impulse response. Every assertion below is a number that came out of a
 * renderer, not a property that was set on an object.
 *
 * THE PLAYER IS REAL. The states are produced by teleporting `window.__game`'s
 * live player into the live collision world, so "a footstep in the void" means
 * a footstep on a collider that `levels/void.js` actually emitted, resolved
 * through the same `_surfaceUnder` scan the game uses.
 *
 * WHAT IT ASSERTS, and why each one is the thing that would break:
 *
 *   1. SURFACE. The void's rock resolves to the void's profile. `Level.solid()`
 *      tags a collider with the CALLER's kind, and `voidkit.js` emits every
 *      ruin as `'stone'` — so without the theme alias in `_profileFor` the
 *      whole level plays the archipelago's sunlit stone. This is the single
 *      most-heard sound in the game and it is the one most likely to silently
 *      regress, because it regresses to something that still sounds fine.
 *   2. BED. The void's ambient bed is low. A wind bed and a sub-bass drone are
 *      both "noise at some level"; the centroid is what tells them apart.
 *   3. ROOM. The void's RT60 is measured in seconds, not in fractions of one.
 *   4. HEIGHT. The bed at the top of the shaft differs from the bed at the
 *      bottom — the course climbs 250 m and that has to be audible.
 *   5. BEAMS. Standing beside an energy beam is louder than standing 200 m from
 *      every one of them.
 *   6. RUNE. A void landing puts energy in the crystal register that the same
 *      landing in the archipelago does not.
 *   7. SKYLINE DOES NOT REGRESS. The shipped theme resolves to the shipped
 *      constants, builds no void layers, and renders the same event sequence
 *      with a bright, dry, short-tailed profile.
 */

import { resolve } from 'node:path'
import { REPO, buildDist, launchBrowser, num, openGame, parseArgs, startStaticServer } from './harness.mjs'

const args = parseArgs(process.argv.slice(2))
const PORT = num(args.port, 5233)
const VERBOSE = !!args.verbose

if (!args['no-build']) buildDist()
const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
const browser = await launchBrowser()

/**
 * Everything below runs INSIDE the page, because moving three seconds of 48 kHz
 * stereo float out to node per state would be ~1 MB a measurement and the
 * numbers are all that matter.
 */
const PROBE = async (page) => page.evaluate(async () => {
  const g = window.__game
  const Audio = g.audio.constructor
  const SR = 48000
  const V = g.player.position.constructor

  // ---------------------------------------------------------------- DSP

  /** In-place iterative radix-2 FFT. Small, standard, and enough for a
   *  centroid — this is measuring where the energy IS, not resolving partials. */
  function fft(re, im) {
    const n = re.length
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len
      const wr = Math.cos(ang), wi = Math.sin(ang)
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k]
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
          re[i + k] = ur + vr; im[i + k] = ui + vi
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi
          const nc = cr * wr - ci * wi
          ci = cr * wi + ci * wr; cr = nc
        }
      }
    }
  }

  /**
   * RMS, peak, spectral centroid and four band energies over a rendered buffer.
   *
   * The analysis window starts at `skip` seconds so a measurement of a
   * CONTINUOUS bed is not dominated by the setTargetAtTime ramp that got it
   * there; for one-shots `skip` is 0 and the whole thing is in frame.
   */
  function measure(buf, skip = 0) {
    const d = buf.getChannelData(0)
    const start = Math.min(d.length - 1, Math.floor(skip * buf.sampleRate))
    let sum = 0, peak = 0
    for (let i = start; i < d.length; i++) {
      const a = d[i]
      sum += a * a
      if (Math.abs(a) > peak) peak = Math.abs(a)
    }
    const rms = Math.sqrt(sum / Math.max(1, d.length - start))

    // Average four Hann-windowed frames, so a bed with a slow LFO on it does
    // not report a different spectrum depending on where the window landed.
    const N = 16384
    const bands = [0, 0, 0, 0]     // <80, 80-300, 300-2k, 2k-8k
    let cNum = 0, cDen = 0
    let frames = 0
    for (let f = 0; f < 4; f++) {
      const off = start + f * Math.floor((d.length - start - N) / 4)
      if (off < 0 || off + N > d.length) continue
      frames++
      const re = new Float64Array(N), im = new Float64Array(N)
      for (let i = 0; i < N; i++) {
        re[i] = d[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)))
      }
      fft(re, im)
      for (let k = 1; k < N / 2; k++) {
        const hz = k * buf.sampleRate / N
        if (hz > 16000) break
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
        cNum += hz * mag; cDen += mag
        const e = mag * mag
        if (hz < 80) bands[0] += e
        else if (hz < 300) bands[1] += e
        else if (hz < 2000) bands[2] += e
        else if (hz < 8000) bands[3] += e
      }
    }
    const tot = bands[0] + bands[1] + bands[2] + bands[3] || 1
    const r = (v) => Math.round(v * 1e5) / 1e5
    return {
      rms: r(rms), peak: r(peak),
      centroid: cDen > 0 ? Math.round(cNum / cDen) : 0,
      frames,
      sub: r(bands[0] / tot), low: r(bands[1] / tot),
      mid: r(bands[2] / tot), high: r(bands[3] / tot),
    }
  }

  /** RT60 of an impulse response, by Schroeder backward integration. The
   *  honest way to ask "how long is this room" — it is the standard, and it
   *  does not care how the tail was generated. */
  function rt60(buf) {
    const d = buf.getChannelData(0)
    let acc = 0
    const e = new Float64Array(d.length)
    for (let i = d.length - 1; i >= 0; i--) { acc += d[i] * d[i]; e[i] = acc }
    const e0 = e[0] || 1
    const at = (db) => {
      const target = e0 * Math.pow(10, db / 10)
      for (let i = 0; i < e.length; i++) if (e[i] <= target) return i / buf.sampleRate
      return e.length / buf.sampleRate
    }
    // -5 to -25 dB extrapolated by 3, the T20 convention: the last 35 dB of a
    // synthetic tail runs into the buffer's own end and would read short.
    const t = (at(-25) - at(-5)) * 3
    return Math.round(t * 100) / 100
  }

  // ------------------------------------------------------------- driving

  /** Build a fresh engine on an offline context under the ACTIVE theme. */
  function engine(seconds) {
    const ctx = new OfflineAudioContext(2, Math.floor(SR * seconds), SR)
    const a = new Audio()
    a.init(ctx)
    return a
  }

  /** Put the real player somewhere in the real world, and re-scan. */
  function place(x, y, z, opts = {}) {
    const p = g.player
    p.teleport(new V(x, y, z))
    p.velocity.set(opts.vx || 0, opts.vy || 0, opts.vz || 0)
    p.grounded = opts.grounded !== false
    return p
  }

  /**
   * Render one continuous state: set it, let every layer settle, measure.
   * An OfflineAudioContext's clock does not advance until it renders, so every
   * setTargetAtTime in `update` is scheduled at t=0 and the render itself is
   * what walks the params to their targets — which is why the measurement
   * window skips the first second.
   */
  async function bed(state, seconds = 4) {
    const a = engine(seconds)
    a._surfAt = -1
    a._probeHits.fill(14)
    // Nine calls so the one-ray-per-frame space probe has filled its table.
    for (let i = 0; i < 12; i++) a.update(state.player, state.ref || 24)
    return { m: measure(await a.ctx.startRendering(), 1.0), a }
  }

  /**
   * Render a one-shot ALONE — no `update`, so no bed under it.
   *
   * Deliberate isolation. With the drone running, 90% of a void render's energy
   * is the bed and every band fraction becomes a measurement of the bed rather
   * than of the cue; the first version of this probe reported a void landing as
   * having LESS crystal register than a skyline one for exactly that reason.
   * The cues do not need `update` anyway: `land`/`step` read their surface from
   * `_surfaceUnder(player)` directly, and the reverb sits at its theme's floor.
   */
  async function shot(fire, seconds = 3) {
    const a = engine(seconds)
    a._surfAt = -1
    // The two reverb params are set to what `update()` computes at enclosure
    // zero. They HAVE to be set by hand here: `_buildReverb` leaves them at the
    // shipped literals on purpose (so the skyline stays bit-identical — see the
    // comment there) and `update` is what owns them from the first frame of
    // play. Skipping this measured a void landing with the archipelago's small
    // bright room on it, which is not a sound that exists in the game.
    a._verbWet.gain.value = a.cfg.verb.floor
    a._verbTone.frequency.value = a.cfg.verb.toneBase
    fire(a)
    return { m: measure(await a.ctx.startRendering(), 0), a }
  }

  // ---------------------------------------------------------------- runs

  const out = { states: {}, cfg: {}, surf: {} }

  // A settled engine, purely to read the resolved config and the room.
  const base = engine(0.2)
  out.cfg = {
    room: base.cfg.room,
    verbFloor: base.cfg.verb.floor,
    windBed: base.cfg.wind.bed,
    hasDrone: !!base.cfg.drone,
    hasRune: !!base.cfg.rune,
    hasVoidAmb: !!base._voidAmb,
    hasBeamHum: !!(base._voidAmb && base._voidAmb._beamOut),
    checkpointHz: base.cfg.bells.checkpointHz,
    bellRatios: base.cfg.bells.ratios,
    stepSend: null,
  }
  out.rt60 = rt60(base._conv.buffer)
  out.irSeconds = Math.round(base._conv.buffer.duration * 100) / 100

  // ---- 1. SURFACE ------------------------------------------------------
  // The spawn pad of whichever course booted. Its collider is emitted by the
  // level, and this is the profile the engine picks for a boot on it.
  // Settled on the ground by the real controller rather than parked at a
  // guessed height: `_surfaceUnder` only accepts a box whose top is within
  // 35 cm of the feet, so a teleport that misses by half a metre silently
  // reports the DEFAULT profile — which is `stone`, i.e. exactly the wrong
  // answer this probe exists to catch.
  g.respawn()
  g.drive(40)
  const spawn = { x: g.player.position.x, y: g.player.position.y, z: g.player.position.z }
  base._surfAt = -1
  const sp = base._surfaceUnder(g.player)
  out.surf.spawn = { texHz: sp.texHz, bodyHz: sp.bodyHz, ring: sp.ring, tFreq: sp.tFreq }
  out.surf.tags = []
  {
    // What the collision world actually says is under the feet, so a failure
    // above can be read as "wrong alias" or "wrong box" without a second run.
    const p = g.player.position
    for (const b of g.player.world.boxes) {
      if (p.x < b.min.x - 0.45 || p.x > b.max.x + 0.45) continue
      if (p.z < b.min.z - 0.45 || p.z > b.max.z + 0.45) continue
      const d = p.y - b.max.y
      if (d > 0.35 || d < -0.2) continue
      if (out.surf.tags.indexOf(b.tag) === -1) out.surf.tags.push(b.tag)
    }
    out.surf.kinds = base._kinds
    out.surf.y = Math.round(p.y * 100) / 100
  }

  // ---- 2/4. BED, low and high -----------------------------------------
  const low = place(spawn.x, spawn.y, spawn.z)
  out.states.bedLow = (await bed({ player: low })).m
  const high = place(spawn.x, 215, spawn.z, { grounded: true })
  out.states.bedHigh = (await bed({ player: high })).m
  const falling = place(spawn.x, 60, spawn.z, { grounded: false, vy: -38 })
  out.states.falling = (await bed({ player: falling })).m

  // ---- 5. BEAMS --------------------------------------------------------
  // Beside the establishing vertical (`hero-2` in fx/voidfx.js), and then far
  // from every beam in the table. Both airborne and stationary, so the only
  // difference between the two renders is which beams are near.
  // The sites come off the engine that built the hum, not from a second copy
  // of the table: if these two ever disagree the probe is measuring nothing.
  const sites = (base._voidAmb && base._voidAmb._sites) || []
  if (sites.length) {
    const s = sites[0]
    const beamY = s.y + s.height * 0.5
    const near = place(s.x + 3, beamY, s.z + 3, { grounded: false })
    out.states.beamNear = (await bed({ player: near })).m
    // 900 m out on both axes, at the SAME height, so the only thing that
    // differs between the two renders is which beams are near — matching the
    // height keeps the drone and the shimmer identical in both.
    const far = place(900, beamY, 900, { grounded: false })
    out.states.beamFar = (await bed({ player: far })).m
  }

  // ---- 6. LANDING ------------------------------------------------------
  const land = place(spawn.x, spawn.y, spawn.z)
  out.states.land = (await shot((a) => a.land(0.8, land), 3)).m
  out.states.step = (await shot((a) => a.step(9, land), 1.5)).m
  out.states.checkpoint = (await shot((a) => a.checkpoint(), 3)).m

  // ---- THE SHIPPING PATH -----------------------------------------------
  // Everything above renders on an OfflineAudioContext, which is the only way
  // to MEASURE. But that is not the path the game takes, so check the real one
  // too: `init()` with no argument, a live AudioContext, under the live theme.
  // `init` swallows its own exceptions and leaves `ready` false, so this is the
  // difference between "the void has a soundscape" and "the void has a
  // soundscape in the test harness".
  {
    g.audio.init()
    out.live = {
      ready: !!g.audio.ready,
      ctx: !!g.audio.ctx,
      voidAmb: !!g.audio._voidAmb,
      beamHum: !!(g.audio._voidAmb && g.audio._voidAmb._beamOut),
      roomHeight: g.audio.cfg.room.height,
      irSeconds: g.audio._conv ? Math.round(g.audio._conv.buffer.duration * 10) / 10 : null,
    }
    // And drive it: `update` is the method that swallows exceptions, so a
    // thrown error inside the void layers would be invisible in play. If any
    // of these frames threw, the params below never moved.
    g.respawn()
    for (let i = 0; i < 8; i++) { g.tick(1 / 60); g.audio.update(g.player, 24) }
    const amb = g.audio._voidAmb
    out.live.droneParam = amb && amb._droneMix ? +amb._droneMix.gain.value.toFixed(6) : null
    out.live.droneTargetSet = !!(amb && amb._droneMix)
  }

  // ---- 7. THE SEQUENCE -------------------------------------------------
  // A fixed run of cues through the whole engine, which is the closest thing
  // to "what the game sounds like" that a number can be. Deterministic: the
  // PRNG in audio.js is seeded, so this is comparable across runs and across
  // themes, and it is the ratchet a future change to this file is checked
  // against.
  {
    const p = place(spawn.x, spawn.y, spawn.z)
    const a = engine(5)
    for (let i = 0; i < 12; i++) a.update(p, 24)
    a.step(9, p); a.jump(p); a.land(0.55, p); a.step(10, p)
    a.walljump(p); a.dash(); a.airjump(); a.grapple(); a.land(0.9, p)
    out.states.sequence = measure(await a.ctx.startRendering(), 0)
  }

  return out
})

const fmt = (m) => `rms ${String(m.rms).padEnd(8)} peak ${String(m.peak).padEnd(8)}`
  + ` centroid ${String(m.centroid).padStart(5)} Hz   bands sub ${m.sub.toFixed(3)}`
  + ` low ${m.low.toFixed(3)} mid ${m.mid.toFixed(3)} high ${m.high.toFixed(3)}`

async function run(theme) {
  const { page, errors } = await openGame(browser, `${server.url}?theme=${theme}`, { width: 640, height: 360 })
  const out = await PROBE(page)
  out.theme = theme
  out.errors = errors.filter((e) => !/favicon/.test(e))
  await page.context().close()
  return out
}

let bad = 0
const fail = (msg) => { console.log(`  FAIL  ${msg}`); bad++ }
const pass = (msg) => { console.log(`  ok    ${msg}`) }

try {
  const sky = await run('skyline')
  const vd = await run('void')

  for (const [name, r] of [['skyline', sky], ['void', vd]]) {
    console.log(`\n=== ${name} ===`)
    console.log(`  room ${r.cfg.room.width}x${r.cfg.room.height}x${r.cfg.room.depth} m`
      + ` reflect ${r.cfg.room.reflect}   IR ${r.irSeconds}s   measured RT60 ${r.rt60}s`)
    console.log(`  verb floor ${r.cfg.verbFloor}   wind bed ${r.cfg.windBed}`
      + `   drone ${r.cfg.hasDrone}   rune ${r.cfg.hasRune}   beamHum ${r.cfg.hasBeamHum}`)
    console.log(`  spawn surface: texHz ${r.surf.spawn.texHz} bodyHz ${r.surf.spawn.bodyHz}`
      + ` tFreq ${r.surf.spawn.tFreq} ring ${r.surf.spawn.ring}`
      + `   [feet y ${r.surf.y}, collider tags ${JSON.stringify(r.surf.tags)},`
      + ` alias ${JSON.stringify(r.surf.kinds)}]`)
    for (const k of Object.keys(r.states)) console.log(`  ${k.padEnd(11)} ${fmt(r.states[k])}`)
    if (r.errors.length) console.log(`  page errors: ${r.errors.join(' | ')}`)
  }

  console.log('\n=== assertions ===')

  // 1. SURFACE.
  if (vd.surf.spawn.texHz === 780 && vd.surf.spawn.bodyHz === 62) {
    pass(`void spawn resolves to voidrock (texHz 780, bodyHz 62), not stone (1500/88)`)
  } else {
    fail(`void spawn is texHz ${vd.surf.spawn.texHz} bodyHz ${vd.surf.spawn.bodyHz}`
      + ` — expected the voidrock profile; the theme alias in _profileFor is not reaching it`)
  }
  if (sky.surf.spawn.texHz !== 780) pass('skyline spawn still resolves to an archipelago profile')
  else fail('skyline spawn resolved to a VOID profile — the alias is leaking')

  // 2. BED.
  const bl = vd.states.bedLow, sl = sky.states.bedLow
  if (bl.rms > 0.0008) pass(`void has an audible bed at rest (rms ${bl.rms})`)
  else fail(`void bed is inaudible at rest (rms ${bl.rms}) — the drone is not running`)
  // The band fraction is the load-bearing number and the centroid is the
  // sanity check, not the other way round. A magnitude-weighted centroid over
  // 5400 bins is pulled up hard by any broadband floor however quiet it is —
  // when the drone was turned down by a factor of three this number tripled
  // while the actual spectrum barely moved. So the bound is RELATIVE to the
  // skyline's, which is what "the bed is much lower than the archipelago's"
  // actually means.
  if (bl.sub + bl.low > 0.90) {
    pass(`the void bed puts ${((bl.sub + bl.low) * 100).toFixed(1)}% of its energy below 300 Hz`
      + ` (${(bl.sub * 100).toFixed(1)}% of it below 80)`)
  } else {
    fail(`only ${((bl.sub + bl.low) * 100).toFixed(1)}% of the void bed is below 300 Hz`)
  }
  if (bl.centroid < sl.centroid / 3) {
    pass(`void bed centroid ${bl.centroid} Hz vs skyline ${sl.centroid} Hz`)
  } else {
    fail(`void bed centroid ${bl.centroid} Hz vs skyline ${sl.centroid} Hz — not a sub-bass bed`)
  }

  // 3. ROOM.
  if (vd.rt60 > 2.5 && vd.rt60 > sky.rt60 * 2.5) {
    pass(`void room RT60 ${vd.rt60}s vs skyline ${sky.rt60}s (measured, Schroeder T20)`)
  } else {
    fail(`void RT60 ${vd.rt60}s / skyline ${sky.rt60}s — the void room is not a cavern`)
  }

  // 4. HEIGHT.
  const bh = vd.states.bedHigh
  const dLevel = (bl.rms - bh.rms) / bl.rms
  if (bh.centroid > bl.centroid * 1.15 && dLevel > 0.10) {
    pass(`height is audible: bottom rms ${bl.rms} / centroid ${bl.centroid} Hz`
      + `  ->  top rms ${bh.rms} / centroid ${bh.centroid} Hz`)
  } else {
    fail(`the bed at y=215 is too close to the bed at the floor`
      + ` (rms ${bl.rms}->${bh.rms}, centroid ${bl.centroid}->${bh.centroid})`)
  }
  if (vd.states.falling.rms > bl.rms * 1.05) {
    pass(`a fast fall swells the bed (rms ${bl.rms} -> ${vd.states.falling.rms})`)
  } else {
    fail(`falling at 38 m/s does not swell the bed (${bl.rms} -> ${vd.states.falling.rms})`)
  }

  // 5. BEAMS.
  if (vd.states.beamNear && vd.states.beamFar) {
    // Measured in the 80-300 Hz band, not on total RMS. The hum sits at 118 Hz
    // and the drone sits under 80, so total RMS is 90% bed either way and would
    // report "no beam" however loud the beam was — the same isolation problem
    // the one-shots above have, arriving through the other door.
    const band = (m) => m.rms * Math.sqrt(m.low)
    const ratio = band(vd.states.beamNear) / Math.max(1e-9, band(vd.states.beamFar))
    if (ratio > 1.6) {
      pass(`beside a beam, the 80-300 Hz band is ${ratio.toFixed(2)}x what it is`
        + ` 900 m from every one (${band(vd.states.beamFar).toFixed(4)}`
        + ` -> ${band(vd.states.beamNear).toFixed(4)})`)
    } else {
      fail(`beam proximity does nothing (80-300 Hz near/far ratio ${ratio.toFixed(2)})`)
    }
  } else {
    fail('no beam sites were reachable — the hum could not be measured')
  }
  if (sky.cfg.hasBeamHum === false) pass('skyline builds no beam hum')
  else fail('skyline built a beam hum')

  // 6. RUNE.
  if (vd.states.land.high > sky.states.land.high * 1.25) {
    pass(`a void landing carries ${(vd.states.land.high * 100).toFixed(1)}% of its energy above 2 kHz`
      + ` vs ${(sky.states.land.high * 100).toFixed(1)}% in the archipelago — the rune answers`)
  } else {
    fail(`the void landing has no more crystal register than the skyline one`
      + ` (${vd.states.land.high} vs ${sky.states.land.high})`)
  }
  if (vd.states.step.centroid < sky.states.step.centroid) {
    pass(`a void footstep is darker than a skyline one (${vd.states.step.centroid} vs ${sky.states.step.centroid} Hz)`)
  } else {
    fail(`the void footstep is not darker (${vd.states.step.centroid} vs ${sky.states.step.centroid} Hz)`)
  }

  // 7. SKYLINE NON-REGRESSION. Structural: the shipped theme must resolve to
  //    the shipped constants and build none of the void's layers.
  const c = sky.cfg
  const okShape = c.room.width === 9 && c.room.height === 5.5 && c.room.depth === 15
    && c.room.reflect === 0.62 && c.verbFloor === 0.05 && c.windBed === 0.15
    && c.hasDrone === false && c.hasRune === false && c.hasVoidAmb === false
    && c.checkpointHz === 520 && c.bellRatios === null
  if (okShape) pass('skyline resolves to the shipped constants and builds no void layer')
  else fail(`skyline config drifted: ${JSON.stringify(c)}`)
  // 8. LEVELS. The mix must survive having a bed in it.
  //
  // The safety compressor in audio.js sits at -18 dBFS (0.126 linear) and is
  // explicitly "a safety device, not a tone shaper: it only ever sees signal
  // when several cues stack". A continuous bed whose PEAK is above that
  // threshold turns it into a permanently-engaged tone shaper, and every cue in
  // the game then arrives into a mix that is already ducking. The first version
  // of the drone measured 0.21 here.
  if (bl.peak < 0.126) {
    pass(`the void bed peaks at ${bl.peak}, under the -18 dBFS compressor threshold`)
  } else {
    fail(`the void bed peaks at ${bl.peak} — it is permanently engaging the safety compressor`)
  }
  const seqRatio = vd.states.sequence.rms / sky.states.sequence.rms
  if (seqRatio < 2.2) {
    pass(`the void's cue sequence is ${seqRatio.toFixed(2)}x the skyline's in RMS`
      + ` (${sky.states.sequence.rms} -> ${vd.states.sequence.rms}), not a bass wall`)
  } else {
    fail(`the void is ${seqRatio.toFixed(2)}x the skyline's overall level — the bed is eating the mix`)
  }
  if (vd.states.sequence.peak <= sky.states.sequence.peak * 1.15) {
    pass(`peak headroom is unchanged (${sky.states.sequence.peak} -> ${vd.states.sequence.peak})`)
  } else {
    fail(`the void sequence peaks ${vd.states.sequence.peak} vs the skyline's ${sky.states.sequence.peak}`)
  }

  // 9. THE SHIPPING PATH.
  if (vd.live.ready && vd.live.voidAmb && vd.live.beamHum && vd.live.roomHeight === 120) {
    pass(`a LIVE AudioContext under ?theme=void builds the void engine`
      + ` (room ${vd.live.roomHeight} m, IR ${vd.live.irSeconds}s, drone + beam hum present)`)
  } else {
    fail(`the real init() path did not build the void engine: ${JSON.stringify(vd.live)}`)
  }
  if (sky.live.ready && !sky.live.voidAmb) pass('a LIVE AudioContext under ?theme=skyline builds no void layer')
  else fail(`skyline live init: ${JSON.stringify(sky.live)}`)

  if (sky.errors.length === 0 && vd.errors.length === 0) pass('no page errors in either theme')
  else fail(`page errors — skyline ${sky.errors.length}, void ${vd.errors.length}`)

  if (VERBOSE) console.log('\n' + JSON.stringify({ sky, vd }, null, 2))
  console.log(bad === 0
    ? '\nPASS — the void has its own acoustic, and the skyline is unchanged'
    : `\nFAIL — ${bad} assertion(s)`)
  process.exitCode = bad === 0 ? 0 : 1
} finally {
  await browser.close()
  await server.close()
}
