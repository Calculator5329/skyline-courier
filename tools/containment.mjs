#!/usr/bin/env node
/**
 * Containment probe for the section-5 underpass flank.
 *
 *   node tools/containment.mjs [--no-build] [--port 5208] [--verbose]
 *
 * WHY THIS EXISTS
 *
 * `tools/reachability.mjs` answers "can the player GET everywhere the course
 * intends". It cannot answer the opposite question — "can the player get OUT
 * of the course where it does not intend" — because it reasons about landing
 * platforms and jump arcs, not about barriers. The underpass shipped with a
 * balustrade whose balusters were `L.mesh` ornament (visual only, no collider
 * by construction), so the run had colliders under the plinth and inside the
 * top rail and a 0.94 m collision hole in between. A standing capsule (1.75 m)
 * is stopped by the top rail and never finds it; the 0.95 m SLIDING capsule
 * that the 1.35 m ceiling *forces* you into steps onto the 0.34 m plinth and
 * goes straight through a barrier the player can plainly see.
 *
 * WHAT IT DOES
 *
 * Drives the real controller through the real slot — sprint in at 11 m/s, hold
 * slide, steer left — and reports every crossing of the deck's -Z edge, with
 * the coordinates. No envelope maths: this is the shipped `player.update`
 * against the shipped collision world, so a pass is a receipt and not an
 * argument.
 *
 * WHAT COUNTS AS A BREACH
 *
 * Leaving the deck's -Z edge BELOW the top of the balustrade (y < 1.5),
 * anywhere along the run the balustrade covers (x 123..149). That is the body
 * passing THROUGH a barrier it can see, which is the bug.
 *
 * Two things are deliberately not failures, and are counted separately so they
 * cannot hide inside a pass:
 *
 *  - Exits over the top of the rail or off the lintel roof. The roof is real
 *    play space (its lanterns stand on it) and the climb verb goes up a 1.6 m
 *    parapet by design. A player who climbs a barrier and launches into the
 *    void chose to, exactly as on every other ledge in the course, and
 *    course-design.md makes that fall recoverable rather than fatal. Walling
 *    it would mean building against the movement set, which is forbidden.
 *  - Exits past x=149, over the apron where the `low-7` branch dashes in from
 *    z=-26. A parapet there would delete an authored route to buy nothing.
 */

import { resolve } from 'node:path'
import {
  REPO, buildDist, launchBrowser, num, openGame, parseArgs, startStaticServer,
} from './harness.mjs'

const PORT = 5208

/** The deck this probe is about: `deck(140, 0, -1.5, 34, 16)` in level.js. */
const DECK = { x0: 123, x1: 157, z0: -9.5, z1: 6.5 }
/** The stretch of the -Z edge the balustrade closes. Past x1 is the low-7 apron. */
const CLOSED = { x0: 123, x1: 149 }
/** Top of that balustrade (`height: 1.5` in level.js). Above it you went over. */
const RAIL_TOP = 1.5

const args = parseArgs(process.argv.slice(2))
const port = num(args.port, PORT)

if (!args['no-build']) buildDist()

const server = await startStaticServer(resolve(REPO, 'dist'), port)
const browser = await launchBrowser()
let failed = false
try {
  const { page, errors } = await openGame(browser, server.url, { width: 640, height: 400 })

  const runs = await page.evaluate(({ DECK }) => {
    const g = window.__game
    const V = g.player.position.constructor
    const DT = 1 / 60
    const out = []

    // Drain the fixed-step accumulator the page built up while loading. Without
    // this the first tick after a teleport burns a 16-substep backlog and the
    // body falls through its own start pose — a fake result in both directions.
    for (let i = 0; i < 30; i++) g.tick(DT)

    for (const slide of [true, false]) {
      for (const turnDeg of [0, 15, 30, 45, 60, 75, 90, 120]) {
        for (const z0 of [-1.5, -5, -7.5]) {
          for (const turnAt of [124, 131.5, 140]) {
            g.keys.clear()
            g.player.teleport(new V(124, 0.02, z0))
            g.rig.yaw = -Math.PI / 2            // forward = +X, so left is -Z
            g.player.velocity.set(11, 0, 0)     // arrive at sprint speed
            g.keys.add('fwd'); g.keys.add('sprint')
            if (slide) g.keys.add('slide')

            let exit = null
            let maxX = -Infinity
            for (let i = 0; i < 300 && !exit; i++) {
              if (turnDeg && g.player.position.x > turnAt) {
                g.rig.yaw = -Math.PI / 2 + turnDeg * Math.PI / 180
              }
              g.tick(DT)
              const p = g.player.position
              if (p.x > maxX) maxX = p.x
              if (p.z < DECK.z0 && p.y > -8) {
                exit = {
                  x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
                  frame: i, sliding: g.player.sliding,
                  speed: +g.player.speed.toFixed(1),
                }
              }
              if (p.y < -30) break
            }
            g.keys.clear()
            out.push({ slide, turnDeg, z0, turnAt, exit, maxX: +maxX.toFixed(1) })
          }
        }
      }
    }
    return out
  }, { DECK })

  if (errors.length) {
    console.error('page errors:')
    for (const e of errors.slice(0, 8)) console.error('  ' + e)
    process.exitCode = 1
  }

  const exits = runs.filter((r) => r.exit)
  const inFlank = exits.filter((r) => r.exit.x >= CLOSED.x0 && r.exit.x <= CLOSED.x1)
  const breaches = inFlank.filter((r) => r.exit.y < RAIL_TOP)
  const overTop = inFlank.filter((r) => r.exit.y >= RAIL_TOP)
  const apron = exits.filter((r) => r.exit.x > CLOSED.x1)

  console.log(`underpass containment — ${runs.length} scripted runs `
    + `(sprint in at 11 m/s, slide/stand × turn 0..120° × 3 entry lines × 3 turn points)`)
  console.log(`  THROUGH the flank x ${CLOSED.x0}..${CLOSED.x1} below the rail top (y<${RAIL_TOP}): ${breaches.length}`)
  console.log(`  OVER the rail / off the lintel roof (y>=${RAIL_TOP}): ${overTop.length} (allowed — the climb verb, and the roof is play space)`)
  console.log(`  over the low-7 apron x > ${CLOSED.x1}: ${apron.length} (allowed — that is a route)`)

  const show = args.verbose ? exits : breaches
  for (const r of show) {
    console.log(`    ${r.slide ? 'SLIDE' : 'stand'} turn ${String(r.turnDeg).padStart(3)}° `
      + `from z=${r.z0} at x=${r.turnAt} -> left the deck at `
      + `x=${r.exit.x} y=${r.exit.y} z=${r.exit.z} (sliding=${r.exit.sliding}, ${r.exit.speed} m/s)`)
  }

  if (breaches.length) {
    failed = true
    console.log('\nCONTAINMENT: FAIL — the flank the balustrade covers is passable.')
  } else {
    console.log('\nCONTAINMENT: OK — no run leaves the deck between '
      + `x=${CLOSED.x0} and x=${CLOSED.x1}.`)
  }
} finally {
  await browser.close()
  await server.close()
}
if (failed) process.exitCode = 1
