#!/usr/bin/env node
/**
 * Wall feedback probe — is a wall-run distinguishable from a climb, and is
 * either distinguishable from falling next to a wall?
 *
 *   node tools/wallfeel.mjs [--no-build] [--shots]
 *
 * `tools/wallprobe.mjs` proves the wall MECHANIC works. This proves the wall
 * is LEGIBLE, which was the other half of the same report: "it's not super
 * intuitive how you're running up the wall versus jumping off of it."
 *
 * Three channels, all of which a screenshot either cannot show or shows badly:
 *
 *  - The HUD's wall gauge. Which gauge is lit, and how full, read straight off
 *    the DOM — so the picture can be checked against the player state that is
 *    supposed to have produced it.
 *  - The impact layer. Particle counts and mean launch velocity out of the
 *    shared mote field: a climb throws its sparks DOWN and a lateral run
 *    throws them BACK, and open air throws nothing.
 *  - The scrape. It has no picture at all, and `Audio.update` swallows its own
 *    exceptions by design, so "no console error" is not evidence. The live
 *    filter is read instead.
 *
 * `--shots` also writes frames to docs/captures/wallfeel/, in both themes.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO, buildDist, hideChrome, launchBrowser, num, openGame, parseArgs, startStaticServer } from './harness.mjs'

const args = parseArgs(process.argv.slice(2))
const PORT = num(args.port, 5231)
const SHOTS = !!args.shots
const OUT = resolve(REPO, 'docs/captures/wallfeel')

// Where each theme's walls are. Both are real course geometry, driven into by
// the shipped controller — no pose is forced, only the approach is set up.
const SETUPS = {
  // Section-4 brass wall: face z = -4.0, x 86..118, top y = 10.
  skyline: {
    climb: { at: [97, 4.0, 0.6], vel: [0, 0, -12], yaw: 0 },
    lateral: { at: [97, 4.2, -3.3], vel: [13.5, 1.2, 0], yaw: Math.PI / 2 },
  },
  // The teaching wall on the void spawn plaza: x -12.5..-9.5, face at x = -9.5.
  void: {
    climb: { at: [-4.0, 1.1, 0], vel: [0, 0, 0], yaw: Math.PI / 2 },
    lateral: { at: [-8.8, 4.2, 0], vel: [0, 1.2, -13.5], yaw: Math.PI },
  },
}

if (!args['no-build']) buildDist()
if (SHOTS) mkdirSync(OUT, { recursive: true })
const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
const browser = await launchBrowser()

let fails = 0
const check = (ok, msg) => { if (!ok) { fails++; console.log(`  FAIL  ${msg}`) } }

try {
  for (const theme of Object.keys(SETUPS)) {
    console.log(`\n── ${theme} ──────────────────────────────────────────────`)
    const { page, errors } = await openGame(browser, `${server.url}?theme=${theme}`,
      { width: 1600, height: 900 })
    await hideChrome(page, { hud: true })

    // The gauges cross-fade over 160 ms of WALL-CLOCK time, and the harness
    // pumps its frames in one synchronous turn — so a shot taken immediately
    // catches the instrument mid-fade and under-reports its own contrast.
    const settle = () => page.waitForTimeout(260)

    /**
     * Approach the wall for real, then hold for `frames` MORE frames measured
     * from the moment the move actually latched.
     *
     * Latch-relative rather than absolute because the two courses put their
     * walls at different distances, and an absolute count that lands mid-climb
     * on one lands past the top of the wall on the other — which measures a
     * landing, not a climb. The mote field is likewise cleared at the latch,
     * so the approach's own dust never counts as the move's.
     */
    const drive = (setup, frames) => page.evaluate(({ setup, frames }) => {
      const g = window.__game
      const V = g.player.position.constructor
      const p = g.player
      g.respawn(); g.keys.clear()
      p.teleport(new V(...setup.at))
      p.velocity.set(...setup.vel)
      p.grounded = !!setup.grounded
      p.wallCooldown = 0; p.climbCooldown = 0
      p.wallTimer = g.TUNING.wallRunTime
      g.rig.yaw = setup.yaw; g.rig.pitch = 0

      const pts = g.scene.getObjectByName('fx-motes')
      const params = pts.geometry.getAttribute('aParams').array
      const vel = pts.geometry.getAttribute('aVel').array
      const retire = () => { for (let i = 0; i < params.length / 4; i++) params[i * 4] = -1000 }
      retire()
      let t0 = pts.material.uniforms.uTime.value

      g.hold('fwd'); g.hold('sprint')
      let latched = setup.control ? 0 : -1
      for (let k = 0; k < 260; k++) {
        g.tick(1 / 120)
        if (latched < 0 && (p.climbTimer > 0 || p.wallRunning)) {
          latched = k
          retire()
          t0 = pts.material.uniforms.uTime.value
        }
        if (latched < 0) continue
        if (setup.climbBelow != null) {
          // Stop on the BUDGET, not on a frame count. The two courses put
          // their walls at different heights, and the void's teaching wall is
          // deliberately short enough that a full climb arrives on the ledge —
          // so a fixed count measures a landing there and a climb here.
          if (p.climbTimer > 0 && p.climbTimer <= setup.climbBelow) break
          if (p.climbTimer === 0) break
        } else if (k - latched >= frames) break
      }
      g.keys.clear()

      let n = 0, sumVY = 0, sumH = 0
      for (let i = 0; i < params.length / 4; i++) {
        if (params[i * 4] < t0) continue
        n++
        sumVY += vel[i * 3 + 1]
        sumH += Math.hypot(vel[i * 3], vel[i * 3 + 2])
      }
      const rail = document.getElementById('wallrail')
      const bar = document.getElementById('wallbar')
      const gauge = (el) => {
        const t = el.firstElementChild.style.transform
        const m = /([0-9.]+)\)/.exec(t)
        return { on: el.classList.contains('on'), low: el.classList.contains('low'),
          coyote: el.classList.contains('coyote'), fill: m ? +(+m[1]).toFixed(2) : null }
      }
      return {
        climbTimer: +g.player.climbTimer.toFixed(2),
        wallRunning: g.player.wallRunning,
        contact: +g.rig.contact.toFixed(2),
        motes: n,
        meanVY: n ? +(sumVY / n).toFixed(2) : 0,
        meanHoriz: n ? +(sumH / n).toFixed(2) : 0,
        verb: document.getElementById('verb').textContent,
        held: document.getElementById('verb').classList.contains('hold'),
        rail: gauge(rail), bar: gauge(bar),
      }
    }, { setup, frames })

    const S = SETUPS[theme]
    const say = (name, r) => console.log(
      `  ${name.padEnd(20)} verb ${String(r.verb || '—').padEnd(9)}${r.held ? '(held) ' : '       '}` +
      `rail ${fmt(r.rail)}  bar ${fmt(r.bar)}  contact ${r.contact.toFixed(2)}  ` +
      `motes ${String(r.motes).padStart(3)} (vy ${String(r.meanVY).padStart(6)}, |h| ${String(r.meanHoriz).padStart(5)})`)

    const climb = await drive(S.climb, 30)
    say('climb', climb)
    check(climb.climbTimer > 0, 'the approach never latched a climb')
    check(climb.verb === 'climb', `verb is "${climb.verb}", expected "climb"`)
    check(climb.rail.on && !climb.bar.on, 'a climb must light the vertical rail and only that')
    check(climb.rail.fill > 0 && climb.rail.fill < 1, `rail reads ${climb.rail.fill}, expected a partial budget`)
    check(climb.motes > 5, 'a climb left nothing in the air')
    check(climb.meanVY < 0, `climb sparks mean vy ${climb.meanVY} — a climb throws them DOWN`)
    check(climb.contact > 0.8, `camera contact ${climb.contact} — a climb is the full-amplitude case`)
    if (SHOTS) { await settle(); await page.screenshot({ path: `${OUT}/${theme}-climb.png` }) }

    const climbEnd = await drive({ ...S.climb, climbBelow: 0.2 }, 0)
    say('climb, spent', climbEnd)
    check(climbEnd.rail.low || climbEnd.rail.coyote,
      'the end of a climb must warm the gauge (low) or hold it lit (coyote)')
    if (SHOTS) { await settle(); await page.screenshot({ path: `${OUT}/${theme}-climb-spent.png` }) }

    const run = await drive(S.lateral, 18)
    say('wall-run', run)
    check(run.wallRunning, 'the approach never latched a lateral wall-run')
    check(run.verb === 'wall-run', `verb is "${run.verb}", expected "wall-run"`)
    check(run.bar.on && !run.rail.on, 'a lateral run must light the horizontal bar and only that')
    check(run.motes > 5, 'a lateral wall-run left nothing in the air')
    check(run.meanHoriz > climb.meanHoriz * 1.5,
      `run sparks trail at ${run.meanHoriz} vs the climb's ${climb.meanHoriz} — a run throws them BACK`)
    check(run.contact > 0.1 && run.contact < climb.contact,
      `camera contact ${run.contact} must be present but below a climb's ${climb.contact}`)
    if (SHOTS) { await settle(); await page.screenshot({ path: `${OUT}/${theme}-wallrun.png` }) }

    // The control. Same speed, same air, no wall — the state the wall cues
    // have to be distinguishable FROM.
    const air = await drive({ at: [60, 40, 60], vel: [13.5, -2, 0], yaw: 0, control: true }, 110)
    say('open air (control)', air)
    check(!air.rail.on && !air.bar.on, 'the wall gauge must not exist off a wall')
    check(air.motes === 0, 'open air must leave nothing in the air')
    // Not zero: the contact channel releases over ~0.4 s so the last frame of a
    // wall does not click off. It must be on its way to nothing, not held.
    check(air.contact < 0.02, `camera contact ${air.contact} a second off a wall — must have released`)

    // ---- the scrape: no picture, and its own exceptions are swallowed ----
    const scrape = await page.evaluate(async (S) => {
      const g = window.__game
      const a = g.audio
      a.init()
      if (a.ctx && a.ctx.state === 'suspended') { try { await a.ctx.resume() } catch { /* muted is fine */ } }
      if (!a.ready) return { skipped: 'no AudioContext in this browser' }
      const V = g.player.position.constructor
      const read = async (setup, frames) => {
        const p = g.player
        g.respawn(); g.keys.clear()
        p.teleport(new V(...setup.at)); p.velocity.set(...setup.vel)
        p.grounded = false; p.wallCooldown = 0; p.climbCooldown = 0
        p.wallTimer = g.TUNING.wallRunTime
        g.rig.yaw = setup.yaw; g.rig.pitch = 0
        g.hold('fwd'); g.hold('sprint')
        // Latch-relative, for the same reason `drive` is: an absolute count
        // that sits mid-climb on one course is past the top of the wall on
        // the other, and silence off the end of a climb is not a measurement
        // of the climb.
        let latched = setup.control ? 0 : -1
        for (let k = 0; k < 260; k++) {
          g.tick(1 / 120)
          if (latched < 0 && (p.climbTimer > 0 || p.wallRunning)) latched = k
          if (latched < 0) continue
          if (setup.climbBelow != null) {
            if (p.climbTimer > 0 && p.climbTimer <= setup.climbBelow) break
            if (p.climbTimer === 0) break
          } else if (k - latched >= frames) break
        }
        // setTargetAtTime only moves as the context clock advances. The sim is
        // held where it is across the wait — `update` is what writes the
        // params, and it is only called from `tick`.
        const hold = { climbTimer: p.climbTimer, wallTimer: p.wallTimer, wallRunning: p.wallRunning }
        for (let w = 0; w < 12; w++) {
          await new Promise((r) => setTimeout(r, 20))
          p.climbTimer = hold.climbTimer; p.wallTimer = hold.wallTimer
          p.wallRunning = hold.wallRunning
          g.tick(1 / 600)
        }
        g.keys.clear()
        return { gain: +a._scrapeGain.gain.value.toFixed(4), hz: Math.round(a._scrape.frequency.value) }
      }
      return {
        climb: await read(S.climb, 12),
        climbEnd: await read({ ...S.climb, climbBelow: 0.2 }, 0),
        run: await read(S.lateral, 18),
        air: await read({ at: [60, 40, 60], vel: [13.5, -2, 0], yaw: 0, control: true }, 30),
      }
    }, S)

    if (scrape.skipped) console.log(`  scrape                skipped — ${scrape.skipped}`)
    else {
      for (const k of ['climb', 'climbEnd', 'run', 'air']) {
        console.log(`  scrape ${k.padEnd(14)} gain ${String(scrape[k].gain).padStart(7)}   band ${String(scrape[k].hz).padStart(5)} Hz`)
      }
      check(scrape.climb.gain > 0.02, 'a climb is silent between its one-shot and whatever ends it')
      check(scrape.run.gain > 0.02, 'a lateral wall-run has no continuous cue')
      check(scrape.air.gain < 0.01, 'the scrape runs off a wall')
      check(scrape.climbEnd.hz > scrape.climb.hz * 1.15,
        `climb band ${scrape.climb.hz} → ${scrape.climbEnd.hz} Hz — it must RISE as the grip runs out`)
      check(scrape.climbEnd.gain < scrape.climb.gain,
        'the scrape must thin as the budget runs out')
      check(scrape.climb.hz > scrape.run.hz * 1.2,
        `climb ${scrape.climb.hz} Hz vs run ${scrape.run.hz} Hz — the two verbs must not sit in the same band`)
    }

    if (errors.length) { fails++; console.log(`  FAIL  console: ${errors.slice(0, 3).join(' | ')}`) }
    await page.close()
  }
} finally {
  await browser.close(); await server.close()
}

function fmt(g) {
  if (!g.on && !g.coyote) return 'off       '
  return `${g.coyote ? 'coyote' : g.low ? 'low   ' : 'lit   '}${String(g.fill ?? '').padStart(4)}`
}

console.log('')
console.log(fails === 0
  ? 'PASS — a climb and a wall-run are told apart by gauge, by spark direction, by camera and by band; open air is none of them'
  : `FAIL — ${fails} check(s)`)
if (SHOTS) console.log(`frames in ${OUT}`)
process.exitCode = fails === 0 ? 0 : 1
