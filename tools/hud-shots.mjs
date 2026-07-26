#!/usr/bin/env node
/**
 * HUD verification, over both worlds, mid-run.
 *
 *   npm run build && node tools/hud-shots.mjs [--out DIR] [--no-build]
 *
 * WHY A THIRD SHOT TOOL. The HUD is the one surface the normal capture harness
 * can never photograph: the first thing `tools/shotset.mjs` does is
 * `hideChrome()`, and it does that for a good reason — HUD pixels are
 * saturated UI colour that would poison every `analyze.mjs` number. So the
 * course shots are, by construction, evidence about the world with the panel
 * cut out of them. `tools/menu-shots.mjs` solved the same problem for the
 * start overlay; this is that pattern with `hideChrome(page, { hud: true })`.
 *
 * It also has to fake a RUN IN PROGRESS. `__SHOT__` deliberately parks
 * `run.started = false` so a course capture always shows a zero timer, and a
 * HUD at 0.00 with no checkpoints lit and no compass exercises almost none of
 * the panel. Every instrument that is hard to get right — the altimeter tape
 * against its index, the compass rose, the checkpoint pips, the speed channel
 * past its redline, the ability lamps — is only drawn once there is state
 * behind it. So each shot re-asserts the pose, then writes a plausible mid-run
 * state onto `run` and holds a key or two, and pumps frames.
 *
 * Shots go OUTSIDE the repo by default (CLAUDE.md rule 1: no image file lands
 * in this tree).
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { REPO, buildDist, hideChrome, launchBrowser, openGame, parseArgs, startStaticServer } from './harness.mjs'

const args = parseArgs(process.argv.slice(2))
const OUT = resolve(args.out || process.env.SHOT_OUT
  || join(process.env.TMPDIR || tmpdir(), 'skyline-hud-shots'))
const PORT = 5193   // 5181 gate, 5187 menu, 5199 capture, 5207 reach, 5231 voidkit

/**
 * One HUD frame.
 *
 * `state` is written onto the live `run` object every pumped frame, because
 * `__SHOT__` resets `run.started` and the tick loop would otherwise advance
 * the clock away from the value we asked for.
 */
/**
 * Hide the world and put the panel on a flat field.
 *
 * This is the REGRESSION shot, and it exists because a shot over the live
 * course cannot answer the only question that matters for the shipped theme:
 * "is the skyline HUD unchanged?" Two captures of the same build differ by
 * ~1.7e8 AE over the archipelago — drifting cloud, motes and the exposure
 * meter — which is an order of magnitude more noise than any HUD edit makes
 * signal. With the canvas hidden the frame is DOM only and therefore exactly
 * reproducible, so `magick compare` against the same shot taken off main is a
 * real pass/fail rather than a number to squint at.
 *
 * The two fields are chosen to be the worlds' extremes, not their averages:
 * whatever the panel is drawn over, it has to hold on both.
 */
const FIELDS = { skyline: '#e8dcc0', void: '#150d26' }

async function shot(browser, base, name, { theme, pose, run, keys = [], size, flat = false }) {
  const url = base + (theme === 'void' ? '?theme=void' : '')
  const { page, errors } = await openGame(browser, url, size)
  await hideChrome(page, { hud: true })
  if (flat) {
    await page.evaluate((bg) => {
      document.querySelector('canvas').style.display = 'none'
      document.body.style.background = bg
      // Transitions and @keyframes are WALL-CLOCK, and the harness's fixed
      // ticks are not — so the compass fade-in, the chip lamps and the nav
      // chevron's breathing all land at whatever progress the run happened to
      // reach, and two captures of the same build disagree across every one of
      // them. Killing both pins each widget at its settled state, which is the
      // state a regression check wants to compare anyway.
      const s = document.createElement('style')
      s.textContent = '#hud, #hud *, #hud *::before, #hud *::after { transition: none !important; animation: none !important }'
      document.head.appendChild(s)
    }, FIELDS[theme])
  }

  const readout = await page.evaluate(({ pose, run, keys }) => {
    const g = window.__game
    window.__SHOT__(pose, true)
    for (const k of keys) g.hold(k)
    for (let i = 0; i < 90; i++) {
      window.__SHOT__(pose)
      // After the pose, not before: __SHOT__ clears `started` every call.
      Object.assign(g.run, run)
      g.tick(1 / 60)
    }
    Object.assign(g.run, run)
    g.tick(1 / 60)
    const txt = (id) => (document.getElementById(id) || {}).textContent
    const on = (id, c) => !!document.getElementById(id)?.classList.contains(c)
    return {
      theme: document.documentElement.dataset.theme,
      hudShown: getComputedStyle(document.getElementById('hud')).display,
      timer: txt('timer'),
      pips: `${document.querySelectorAll('#cppips b.hit').length}/${document.querySelectorAll('#cppips b').length}`,
      speed: txt('speednum'),
      hotBar: on('speedbar', 'hot'),
      verb: txt('verb'),
      altitude: txt('altval'),
      bearing: txt('cread'),
      compassLive: on('compass', 'live'),
      altLive: on('alt', 'live'),
      navLive: on('nav', 'live'),
      lamps: [...document.querySelectorAll('.chip')].map((c) => `${c.id.slice(5)}:${c.classList.contains('ready') ? 'on' : 'off'}`).join(' '),
      // The one thing a screenshot cannot tell you: whether the alloy actually
      // switched, or whether a selector missed and the panel is still brass.
      alloy: getComputedStyle(document.getElementById('hud')).getPropertyValue('--brass').trim(),
      gradStop: document.querySelector('#gbrass stop') ? getComputedStyle(document.querySelector('#gbrass stop')).stopColor : null,
    }
  }, { pose, run, keys })

  await page.screenshot({ path: `${OUT}/${name}.png`, type: 'png' })
  console.log(name.padEnd(22), JSON.stringify(readout), errors.length ? `ERRORS ${JSON.stringify(errors)}` : 'clean')
  await page.context().close()
  return { readout, errors }
}

async function main() {
  if (!args['no-build']) buildDist()
  await mkdir(OUT, { recursive: true })
  const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
  const browser = await launchBrowser()
  const size = { width: 1600, height: 900 }

  // A believable mid-run: over a minute in, a third of the checkpoints taken.
  const midRun = { time: 78.42, started: true, finished: false, checkpointsHit: 5 }

  try {
    // The two worlds, matched as closely as two different courses allow: a
    // bright open vantage in each, then a dark/low one in each.
    await shot(browser, server.url, 'hud-skyline-vista',
      { theme: 'skyline', pose: 'vista', run: midRun, keys: ['fwd', 'sprint'], size })
    await shot(browser, server.url, 'hud-skyline-crossing',
      { theme: 'skyline', pose: 'crossing', run: midRun, keys: ['fwd', 'sprint'], size })
    await shot(browser, server.url, 'hud-void-ascent',
      { theme: 'void', pose: 'ascent', run: midRun, keys: ['fwd', 'sprint'], size })
    await shot(browser, server.url, 'hud-void-midclimb',
      { theme: 'void', pose: 'midclimb', run: midRun, keys: ['fwd', 'sprint'], size })
    await shot(browser, server.url, 'hud-void-plunge',
      { theme: 'void', pose: 'plunge', run: midRun, keys: [], size })
    await shot(browser, server.url, 'hud-void-summit',
      { theme: 'void', pose: 'summit', run: midRun, keys: ['fwd', 'sprint'], size })

    // A cold panel with nothing behind it: every instrument at rest, which is
    // the state where an unlit pip or an empty speed channel has to still read.
    await shot(browser, server.url, 'hud-void-idle',
      { theme: 'void', pose: 'ascent', run: { time: 0, started: false, finished: false, checkpointsHit: 0 }, keys: [], size })
    await shot(browser, server.url, 'hud-skyline-idle',
      { theme: 'skyline', pose: 'terrace', run: { time: 0, started: false, finished: false, checkpointsHit: 0 }, keys: [], size })

    // The regression pair. DOM only, so these are byte-reproducible: capture
    // them off main and off the branch and compare. `hud-flat-skyline` must be
    // pixel-identical, because skyline is the shipped look and the baseline.
    await shot(browser, server.url, 'hud-flat-skyline',
      { theme: 'skyline', pose: 'crossing', run: midRun, keys: ['fwd', 'sprint'], size, flat: true })
    await shot(browser, server.url, 'hud-flat-void',
      { theme: 'void', pose: 'midclimb', run: midRun, keys: ['fwd', 'sprint'], size, flat: true })

    // ---- the two ways the HUD is made to disappear -----------------------
    // Both hide `#hud` by id and both are load-bearing: `hideChrome()` is what
    // every other capture tool depends on, and photo mode is a player-facing
    // feature. A theme that reached for `display` on the panel would break
    // either one silently and no screenshot would show it.
    const { page } = await openGame(browser, server.url + '?theme=void', size)
    const hide = await page.evaluate(() => {
      const h = document.getElementById('hud')
      document.getElementById('overlay').classList.add('hidden')
      h.style.display = 'none'
      const hidden = getComputedStyle(h).display
      h.style.display = ''
      return { hiddenByHarness: hidden, restored: getComputedStyle(h).display }
    })
    await page.keyboard.press('KeyP')
    const photo = await page.evaluate(() => getComputedStyle(document.getElementById('hud')).display)
    await page.keyboard.press('KeyP')
    const back = await page.evaluate(() => getComputedStyle(document.getElementById('hud')).display)
    console.log('hideChrome/photo ->', JSON.stringify({ ...hide, photoMode: photo, afterPhoto: back }))
    if (hide.hiddenByHarness !== 'none' || hide.restored === 'none' || photo !== 'none' || back === 'none') {
      throw new Error('the HUD can no longer be hidden and restored by id')
    }
    await page.context().close()
  } finally {
    await browser.close()
    await server.close()
  }
  console.log(`\nshots -> ${OUT}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
