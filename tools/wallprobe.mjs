#!/usr/bin/env node
/**
 * Wall-verb probe — does a climb end in a wall-jump or in a wasted air jump?
 *
 *   node tools/wallprobe.mjs [--no-build]
 *
 * Ethan, playing: "wall climbing and jumping stuff is a little bit off... it's
 * not super intuitive how you're running up the wall versus jumping off of it."
 *
 * The measurable half of that: the wall-jump gate used `_probeWall()`, the
 * LATERAL probe, and `_tryClimb` states that the side probes "sweep past a
 * head-on wall and never touch it". So after running UP a wall, Space could not
 * see it and silently spent the air jump instead. This drives the shipped
 * controller into the shipped collision world and counts which event actually
 * fires.
 */
import { resolve } from 'node:path'
import { REPO, buildDist, launchBrowser, num, openGame, parseArgs, startStaticServer } from './harness.mjs'

const args = parseArgs(process.argv.slice(2))
const PORT = num(args.port, 5227)

if (!args['no-build']) buildDist()
const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
const browser = await launchBrowser()
try {
  const { page } = await openGame(browser, server.url, { width: 640, height: 360 })
  const out = await page.evaluate(() => {
    const g = window.__game
    const STEP = 1 / 120
    const V = g.player.position.constructor

    // DETERMINISTIC, not an approach run. An earlier version of this probe
    // sprinted at the section-4 wall and latched a climb in 1 trial of 12 —
    // the approach geometry, not the mechanic, was what it was measuring. This
    // puts the player in the exact state under test instead: mid-climb, on a
    // known wall, and then presses Space.
    const trial = (setup) => {
      g.respawn()
      const p = g.player
      g.keys.clear()
      g.input.jumpPressed = false; g.input.jumpHeld = false
      // Beside the section-4 brass wall (face z = -4.0, x 86..118, top y = 10),
      // airborne and just off the face.
      p.teleport(new V(97, 4.0, -3.55))
      p.velocity.set(0, 0, 0)
      g.rig.yaw = 0; g.rig.pitch = 0
      p.grounded = false
      // `respawn()` does not clear `wallCooldown`, so without this the second
      // and third trials run with the first trial's wall-jump regrab cooldown
      // still ticking and the whole wall branch is closed. That is also a real
      // (small) bug in its own right — see docs/roadmap.md.
      p.wallCooldown = 0
      setup(p)
      const before = { vy: p.velocity.y, vz: p.velocity.z }
      const dbg = { coyote0: p.wallCoyote, cd: p.wallCooldown, climb: p.climbTimer }
      g.input.jumpPressed = true
      g.input.jumpHeld = true
      for (let k = 0; k < 3; k++) g.tick(STEP)
      const after = { vy: p.velocity.y, vz: p.velocity.z }
      g.keys.clear()
      // A wall-jump pushes OUT along the wall normal (+Z here, away from the
      // face) and UP by wallJumpUp. An air jump only adds Y.
      return { outward: after.vz - before.vz, up: after.vy - before.vy,
        dbg, coyoteAfter: p.wallCoyote }
    }

    const climbing = trial((p) => {
      p.climbTimer = 0.4
      p.wallNormal.set(0, 0, 1)          // face at z=-4, so the normal is +Z
    })
    const coyote = trial((p) => {
      p.climbTimer = 0
      p.wallCoyote = 0.2
      p.lastWallNormal.set(0, 0, 1)
      p.wallNormal.set(0, 0, 1)
    })
    const nowall = trial((p) => {
      p.teleport(new V(60, 30, 40))      // open air, nothing within reach
      p.climbTimer = 0; p.wallCoyote = 0
    })
    return { climbing, coyote, nowall, wallJumpOut: g.TUNING.wallJumpOut, climbTime: g.TUNING.climbTime }
  })

  const OUT = out.wallJumpOut * 0.5   // generous: three sim steps of drag
  const say = (name, r) => console.log(
    `  ${name.padEnd(22)} outward ${r.outward.toFixed(2).padStart(6)} m/s   up ${r.up.toFixed(2).padStart(6)} m/s` +
    `   [coyote ${r.dbg.coyote0.toFixed(2)}->${r.coyoteAfter.toFixed(2)} wallCd ${r.dbg.cd.toFixed(2)} climb ${r.dbg.climb.toFixed(2)}]`)
  console.log(`wall-verb probe — climbTime ${out.climbTime}s, wallJumpOut ${out.wallJumpOut}`)
  say('mid-climb + Space', out.climbing)
  say('just after (coyote)', out.coyote)
  say('open air (control)', out.nowall)
  console.log('')
  const okClimb = out.climbing.outward > OUT
  const okCoyote = out.coyote.outward > OUT
  const okControl = out.nowall.outward < 1.0
  console.log(okClimb && okCoyote && okControl
    ? 'PASS — a head-on wall is jumpable while climbing and briefly after; open air still air-jumps'
    : `FAIL — climb ${okClimb} coyote ${okCoyote} control ${okControl}`)
  process.exitCode = okClimb && okCoyote && okControl ? 0 : 1
} finally {
  await browser.close(); await server.close()
}
