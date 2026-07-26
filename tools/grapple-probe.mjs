#!/usr/bin/env node
/**
 * Insta-detach probe for the brass cuff.
 *
 *   node tools/grapple-probe.mjs [--no-build] [--port 5209] [--verbose]
 *
 * WHY THIS EXISTS
 *
 * Ethan, playing FUN: "sometimes I'll hold down F and it'll like attach to the
 * grapple thing and then immediately detach, which is annoying." Intermittent,
 * and F is still HELD throughout — so it is not an input edge being eaten, it
 * is the release test firing on a latch that never got to pull anybody.
 *
 * WHAT IT DOES
 *
 * Drives the shipped controller against the shipped collision world, on both
 * courses and in both modes. For every anchor the level places, it puts the
 * player at a spread of legal stand-off distances and approach speeds, aims
 * squarely at the anchor, holds F, and ticks at the fixed step until the line
 * drops. It records how long each latch survived and why it ended.
 *
 * WHAT COUNTS AS THE BUG
 *
 * A latch that ends within `INSTA_STEPS` sim steps of firing. At 1/120 s that
 * is under a twelfth of a second — the player sees the line appear and vanish
 * in the same eyeblink, which is exactly the report. Latches that end because
 * the player genuinely flew the whole line (timeout, a real arrival after a
 * real pull, a real landing) are the working case and are counted separately.
 */

import { resolve } from 'node:path'
import {
  REPO, buildDist, launchBrowser, num, openGame, parseArgs, startStaticServer,
} from './harness.mjs'

const PORT = 5209

/** A latch shorter than this many fixed steps is an insta-detach. 1/120 s each. */
const INSTA_STEPS = 10

const args = parseArgs(process.argv.slice(2))
const port = num(args.port, PORT)

if (!args['no-build']) buildDist()

const server = await startStaticServer(resolve(REPO, 'dist'), port)
const browser = await launchBrowser()
let failed = false

/** Runs the sweep inside the page for one already-booted course. */
const SWEEP = ({ mode, INSTA_STEPS }) => {
  const g = window.__game
  const V = g.player.position.constructor
  const DT = 1 / 120                      // one tick == one sim step
  g.setMode(mode)

  // Drain the accumulator the page banked while loading, or the first tick
  // after a teleport burns a 16-substep backlog and the body falls through
  // its own start pose.
  for (let i = 0; i < 40; i++) g.tick(DT)

  const T = g.TUNING
  const out = []
  const anchors = g.player.anchors

  // Stand-off distances across the legal band, deliberately dense just outside
  // `grappleMinRange` because that is where a mid-span anchor puts you.
  const DISTS = [5.2, 6.5, 9, 14, 22, 31]
  // Approach azimuths around the anchor, and how much of the offset is
  // horizontal (the rest is the anchor being above you, the usual case).
  const AZ = [0, 1, 2, 3]
  const DROPS = [0.4, 0.8]
  const SPEEDS = [0, 15, 28]              // arrival speed, aimed at the anchor
  // Once a latch has survived this long it is emphatically not the reported
  // bug, and flying the rest of the arc costs the sweep more than it tells it.
  const WATCH = 96                        // 0.8 s of fixed steps

  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    for (const dist of DISTS) {
      for (const azi of AZ) {
        const az = (azi / AZ.length) * Math.PI * 2
        for (const drop of DROPS) {
          const horiz = dist * drop
          const vert = Math.sqrt(Math.max(0, dist * dist - horiz * horiz))
          const px = a.x + Math.cos(az) * horiz
          const pz = a.z + Math.sin(az) * horiz
          const py = a.y - vert
          if (py < -20) continue
          const start = new V(px, py, pz)
          // Skip poses buried in geometry: the controller would spend the run
          // being extruded out of a wall, which measures nothing.
          if (!g.player.world.isClear(start, T.radius, T.standHeight, [])) continue

          for (const speed of SPEEDS) {
            g.keys.clear()
            g.input.grapplePressed = false
            g.input.grappleHeld = false
            g.player.teleport(start)

            // Look squarely at the anchor: that is what a player who means to
            // hook it does, and it takes anchor SELECTION out of the result.
            const dx = a.x - px, dy = a.y - py, dz = a.z - pz
            const dh = Math.hypot(dx, dz)
            g.rig.yaw = Math.atan2(-dx, -dz)
            g.rig.pitch = Math.atan2(dy, dh)

            if (speed > 0) {
              const l = Math.hypot(dx, dy, dz)
              g.player.velocity.set(dx / l * speed, dy / l * speed, dz / l * speed)
            }

            // Hold F. `grapplePressed` is an edge consumed by a sim step;
            // `grappleHeld` stays true for the whole attempt, which is the
            // report's condition.
            g.input.grappleHeld = true
            g.input.grapplePressed = true
            g.player.lastRelease = null      // so a stale reason cannot be read

            let steps = 0
            let latched = false
            let latchStep = -1
            let capped = false
            for (let i = 0; i < WATCH + 8; i++) {
              g.tick(DT)
              steps++
              if (g.player.grappling) {
                if (!latched) { latched = true; latchStep = steps }
                if (steps - latchStep + 1 >= WATCH) { capped = true; break }
              } else if (latched) {
                break
              }
              if (!latched && steps > 4) break     // never fired at all
              if (g.player.position.y < -60) break
            }
            g.input.grappleHeld = false
            g.input.grapplePressed = false
            g.keys.clear()

            if (!latched) continue

            const held = steps - latchStep + 1
            const p = g.player.position
            const endDist = Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z)
            // The reason comes off the player, not out of an inference on the
            // end state — see `Player.lastRelease`. A probe that guesses why
            // the line came off cannot be used to check that the reasons are
            // right.
            const why = capped ? 'flying' : (g.player.lastRelease?.reason ?? 'unknown')

            out.push({
              ai, dist, az: azi, drop, speed,
              held, why,
              insta: held <= INSTA_STEPS,
              x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1),
              endDist: +endDist.toFixed(2),
            })
          }
        }
      }
    }
  }
  return out
}

/**
 * Does a HELD F acquire an anchor with no fresh key press?
 *
 * `grapplePressed` is never set here, so the only thing that can fire the cuff
 * is `grappleHoldRelatch`. Airborne must fire in FUN and must not in NORMAL;
 * grounded must not fire in either, because a grounded auto-latch would yank a
 * player off the roof they meant to be running along.
 */
const RELATCH = () => {
  const g = window.__game
  const V = g.player.position.constructor
  const DT = 1 / 120
  for (let i = 0; i < 40; i++) g.tick(DT)

  const T = g.TUNING
  const anchors = g.player.anchors
  const out = { air: { tried: 0, fired: 0 }, ground: { tried: 0, fired: 0 } }

  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai]
    for (const dist of [8, 14, 22]) {
      for (const grounded of [false, true]) {
        // Straight out sideways from the anchor, level with it: a clean shot
        // with nothing to fall onto for the airborne case.
        const px = a.x + dist, pz = a.z, py = a.y
        const start = new V(px, py, pz)
        if (!g.player.world.isClear(start, T.radius, T.standHeight, [])) continue

        g.keys.clear()
        g.player.teleport(start)
        g.rig.yaw = Math.atan2(dist, 0)
        g.rig.pitch = 0
        // `grounded` is recomputed by the integrator from real contacts, so it
        // is forced here for exactly the step the trigger reads it on.
        g.player.grounded = grounded
        g.input.grapplePressed = false          // the whole point: no press
        g.input.grappleHeld = true

        const bucket = grounded ? out.ground : out.air
        bucket.tried++
        let fired = false
        for (let i = 0; i < 3; i++) {
          if (grounded) g.player.grounded = true
          g.tick(DT)
          if (g.player.grappling) { fired = true; break }
        }
        if (fired) bucket.fired++
        g.input.grappleHeld = false
        g.keys.clear()
      }
    }
  }
  return out
}

function summarise(label, rows) {
  const insta = rows.filter((r) => r.insta)
  const byWhy = {}
  for (const r of insta) byWhy[r.why] = (byWhy[r.why] || 0) + 1
  const pct = rows.length ? (100 * insta.length / rows.length).toFixed(1) : '0.0'
  const all = {}
  for (const r of rows) all[r.why] = (all[r.why] || 0) + 1
  const held = rows.map((r) => r.held).sort((x, y) => x - y)
  const med = held.length ? held[held.length >> 1] : 0
  console.log(`  ${label.padEnd(16)} ${String(rows.length).padStart(5)} latches  `
    + `insta ${String(insta.length).padStart(4)} (${pct.padStart(4)}%)  `
    + `median hold ${String(med).padStart(3)} steps  `
    + `[${Object.entries(all).sort().map(([k, v]) => `${k}=${v}`).join(' ')}]`)
  if (insta.length) {
    const byDist = {}
    const bySpeed = {}
    for (const r of insta) {
      byDist[r.dist] = (byDist[r.dist] || 0) + 1
      bySpeed[r.speed] = (bySpeed[r.speed] || 0) + 1
    }
    console.log(`      insta by reason:    `
      + Object.entries(byWhy).sort().map(([k, v]) => `${k}=${v}`).join(' '))
    console.log(`      insta by fire dist: `
      + Object.entries(byDist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}m=${v}`).join(' '))
    console.log(`      insta by approach:  `
      + Object.entries(bySpeed).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}m/s=${v}`).join(' '))
  }
  return insta
}

try {
  const results = {}
  const relatch = {}
  for (const theme of ['skyline', 'void']) {
    const url = theme === 'void' ? server.url + '?theme=void' : server.url
    for (const mode of ['fun', 'normal']) {
      const { context, page, errors } = await openGame(browser, url, { width: 640, height: 400 })
      const rows = await page.evaluate(SWEEP, { mode, INSTA_STEPS })
      relatch[`${theme}/${mode}`] = await page.evaluate(RELATCH)
      await context.close()
      if (errors.length) {
        console.error('page errors:')
        for (const e of errors.slice(0, 8)) console.error('  ' + e)
        process.exitCode = 1
      }
      results[`${theme}/${mode}`] = rows
    }
  }

  console.log(`grapple insta-detach probe — a latch ending within ${INSTA_STEPS} `
    + `fixed steps (${(INSTA_STEPS / 120).toFixed(3)} s) with F still held`)
  let total = 0
  let instaTotal = 0
  for (const [label, rows] of Object.entries(results)) {
    const insta = summarise(label, rows)
    total += rows.length
    instaTotal += insta.length
    if (args.verbose) {
      for (const r of insta.slice(0, 12)) {
        console.log(`      anchor#${r.ai} d=${r.dist} az=${r.az} drop=${r.drop} `
          + `v=${r.speed} -> held ${r.held} steps, ${r.why}, endDist ${r.endDist}`)
      }
    }
  }

  console.log(`\n  TOTAL ${instaTotal} / ${total} latches insta-detached`)

  // --- held-F re-acquire, which is FUN-only by design ---------------------
  console.log('\nheld-F re-acquire with NO fresh key press (grappleHoldRelatch)')
  let relatchBad = 0
  for (const [label, r] of Object.entries(relatch)) {
    const mode = label.split('/')[1]
    const wantAir = mode === 'fun'
    const airOK = wantAir ? r.air.fired === r.air.tried : r.air.fired === 0
    const groundOK = r.ground.fired === 0
    if (!airOK || !groundOK) relatchBad++
    console.log(`  ${label.padEnd(16)} airborne ${r.air.fired}/${r.air.tried} `
      + `(want ${wantAir ? 'all' : 'none'})   grounded ${r.ground.fired}/${r.ground.tried} `
      + `(want none)   ${airOK && groundOK ? 'OK' : 'WRONG'}`)
  }
  if (relatchBad) failed = true

  if (instaTotal > 0 || relatchBad) {
    failed = true
    console.log('\nGRAPPLE: FAIL — a latch dropped within a few steps of biting, '
      + 'or the held-F rule fired in the wrong mode/stance.')
  } else {
    console.log('\nGRAPPLE: OK — every latch that fired got to pull, and held-F '
      + 're-acquire is airborne-FUN-only.')
  }
} finally {
  await browser.close()
  await server.close()
}
if (failed) process.exitCode = 1
