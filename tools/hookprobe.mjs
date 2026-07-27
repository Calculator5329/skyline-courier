#!/usr/bin/env node
/**
 * Fast grapple insta-detach probe.
 *
 *   node tools/hookprobe.mjs [--theme void] [--mode normal] [--no-build]
 *
 * WHY A SECOND ONE. `tools/grapple-probe.mjs` is thorough and it TIMES OUT on
 * the merged tree — the courses grew to 3 M triangles and it opens the game per
 * sweep. So the fix it verified (0 / 27918) has never actually been confirmed on
 * main, and Ethan hit the bug again in play: "in legacy sometimes I hold f then
 * the grapple randomly detaches like right afterwards (not after hanging on for
 * awhile). this happened to me while holding W but seemed to happen without as
 * well."
 *
 * A check that cannot finish is a check nobody runs. This one opens the page
 * ONCE, drives from real anchors the level actually placed, and reads the
 * enumerated release reason off `player.lastRelease` rather than inferring it.
 */
import { resolve } from 'node:path'
import { DEFAULTS, REPO, buildDist, launchBrowser, num, openGame, parseArgs,
         startStaticServer } from './harness.mjs'

const args = parseArgs(process.argv.slice(2))
const theme = args.theme && args.theme !== true ? String(args.theme) : 'skyline'
const mode = args.mode && args.mode !== true ? String(args.mode) : 'normal'
const MOVE = !!args.move
if (!args['no-build']) buildDist()
const server = await startStaticServer(resolve(REPO, 'dist'), num(args.port, 5261))
const browser = await launchBrowser()
try {
  const url = `${server.url}?theme=${theme}`
  const { page } = await openGame(browser, url, { width: 640, height: 360 })
  const out = await page.evaluate(({ mode, move }) => {
    const g = window.__game
    g.setMode(mode)
    const p = g.player, V = p.position.constructor
    const STEP = 1 / 120
    // INSTA = the line dies within 10 fixed steps (0.083 s) while F is HELD.
    const INSTA = 10
    const anchors = g.level.anchors || []
    const rows = []
    // Sample across the whole course rather than one spot: the bug was reported
    // as intermittent, and an intermittent bug measured in one place is a bug
    // measured once.
    const step = Math.max(1, Math.floor(anchors.length / 40))
    for (let i = 0; i < anchors.length; i += step) {
      const a = anchors[i]
      for (const back of [9, 15, 22]) {
        for (const speed of [0, 11, 20]) {
          g.respawn()
          p.wallCooldown = 0; p.grappleCooldown = 0
          // Grant every verb. Progressive unlocks gate the grapple behind course
          // progress, which is correct for a PLAYER and wrong for a probe whose
          // whole job is to exercise the grapple. Unlock explicitly rather than
          // teleporting far enough along to earn it.
          // Progressive unlocks enforce the grapple by emptying `player.anchors`
          // until checkpoint 7 (src/hud.js `gate`/`release`). Correct for a
          // player; wrong for a probe whose entire job is the grapple, which
          // spawns at checkpoint 0 and would otherwise measure a locked ability
          // and call it a pass. Hand the list back explicitly.
          p.anchors = g.level.anchors
          // Stand off the anchor along -X, level with it, aimed at it.
          p.teleport(new V(a.x - back, a.y, a.z))
          p.velocity.set(speed, 0, 0)
          p.grounded = false
          // AIM AT THE ANCHOR, worked rather than assumed. The first version
          // wrote `atan2(-1,0) + PI/2`, which is 0 — and yaw 0 looks along -Z,
          // not +X. It latched 9 times in 225 attempts and reported PASS, which
          // is how a probe lies: almost every trial never fired at all, so
          // there was nothing for the bug to happen to. yawTo(dx,dz) is
          // atan2(-dx,-dz); see tools/shots.mjs, which documents this as the
          // one bit of trigonometry in the project and warns it is easy to
          // invert.
          g.rig.yaw = Math.atan2(-(a.x - p.position.x), -(a.z - p.position.z))
          g.rig.pitch = 0
          g.input.grapplePressed = true
          g.input.grappleHeld = true
          // HOLD W TOO, and sprint. Ethan named this as the differentiating
          // variable — "this happened to me while holding W" — and a probe that
          // only holds F is testing a case the player never plays. Steering
          // while on the line moves the capsule relative to the anchor, which
          // is exactly the kind of thing a release condition can trip on.
          if (move) { g.keys.add('fwd'); g.keys.add('sprint') }
          let held = 0, latched = false
          for (let k = 0; k < 240; k++) {
            g.tick(STEP)
            g.input.grapplePressed = false
            g.input.grappleHeld = true          // HELD throughout
            if (p.grappling) { latched = true; held++ }
            else if (latched) break
          }
          g.input.grappleHeld = false
          g.keys.clear()
          if (latched) {
            rows.push({ held, back, speed,
              reason: (p.lastRelease && p.lastRelease.reason) || '?' })
          }
        }
      }
    }
    const insta = rows.filter((r) => r.held <= INSTA)
    const byReason = {}
    for (const r of insta) byReason[r.reason] = (byReason[r.reason] || 0) + 1
    const med = rows.length
      ? rows.map((r) => r.held).sort((a, b) => a - b)[rows.length >> 1] : 0
    return { anchors: anchors.length, latches: rows.length, insta: insta.length,
             medianHeld: med, byReason, sample: insta.slice(0, 5) }
  }, { mode, move: MOVE })
  const pct = out.latches ? (100 * out.insta / out.latches).toFixed(1) : '0.0'
  console.log(`hook probe — theme ${theme}, mode ${mode}, holding W: ${MOVE}`)
  console.log(`  anchors ${out.anchors} | latches ${out.latches} | median held ${out.medianHeld} steps`)
  console.log(`  INSTA-DETACH (<=10 steps, F held): ${out.insta} / ${out.latches} = ${pct}%`)
  if (out.insta) {
    console.log('  by reason:', JSON.stringify(out.byReason))
    for (const s of out.sample) console.log(`    held ${s.held} back ${s.back}m speed ${s.speed} -> ${s.reason}`)
  }
  console.log('')
  // ZERO LATCHES IS A FAILURE, NOT A PASS. This bit twice: first when a yaw
  // bug meant 9 attempts in 225 ever fired, and again the moment progressive
  // unlocks gated the grapple at spawn — the probe cheerfully reported
  // "0 / 0 = 0.0% PASS" while measuring nothing at all. A check that cannot
  // fail is not a check.
  if (out.latches === 0) {
    console.log('FAIL — NOTHING LATCHED. The probe measured nothing, which is not a pass.')
    console.log('  Likely: the grapple is not unlocked yet (see progressive unlocks in')
    console.log('  src/level.js / src/hud.js), the aim missed, or no anchor was in range.')
    process.exitCode = 1
  } else {
    console.log(out.insta === 0 ? 'PASS — no latch died while F was held'
      : `FAIL — ${out.insta} latches died within 0.083 s with F held`)
    process.exitCode = out.insta === 0 ? 0 : 1
  }
} finally { await browser.close(); await server.close() }
