#!/usr/bin/env node
/**
 * Menu verification.
 *
 *   npm run build && node tools/menu-shots.mjs [--out DIR]
 *
 * The start overlay is the one screen that is guaranteed to be drawn over a
 * LIVE 3D frame, and the two frames it can be drawn over could not be further
 * apart: a blown-out golden sky and a near-black void. `tools/shotset.mjs`
 * cannot see any of it, because the first thing the capture harness does is
 * `hideChrome()`. So the menu gets its own shot set, over both themes, at a
 * desktop, a 1280x720 laptop and a window narrow enough to stack the picker,
 * plus the three behaviours that are easy to break and invisible in a
 * screenshot:
 *
 *   - picking a difficulty must NOT start the run,
 *   - opening the controls disclosure must NOT start the run,
 *   - picking the other world must persist and survive a bare reload.
 *
 * Shots go OUTSIDE the repo by default: no image file has ever been allowed
 * to land in this tree (CLAUDE.md rule 1) and a verification artefact is not
 * the exception that changes that.
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { REPO, launchBrowser, openGame, parseArgs, startStaticServer } from './harness.mjs'

const OUT = resolve(parseArgs(process.argv.slice(2)).out
  || process.env.SHOT_OUT
  || join(process.env.TMPDIR || tmpdir(), 'skyline-menu-shots'))
const port = 5187

/**
 * Land every in-flight CSS transition on its end state.
 *
 * This is not a nicety, it is the difference between a true and a false
 * screenshot. `openGame` stubs `requestAnimationFrame` so the game renders
 * exactly the frames the harness asks for — but with rAF gone the page also
 * stops producing compositor frames, and a CSS transition that never gets a
 * frame never advances. The picked card's state is applied by `hud.setMap()`
 * AFTER first style resolution, so every menu capture ever taken by this file
 * was frozen at the moment BEFORE the selection landed: the shots showed the
 * chosen world's thumbnail still wearing the unpicked scrim, which is exactly
 * the thing these shots exist to verify. Finishing the transitions gives the
 * settled menu a human sees a fraction of a second after load.
 *
 * Only transitions are finished. The infinite `pulse` on the start button is a
 * CSSAnimation and cannot finish; leaving it is also what we want, since its
 * frozen phase is deterministic across every shot in the set.
 */
async function settle(page) {
  return page.evaluate(() => {
    const t = document.getAnimations().filter((a) => a.constructor.name === 'CSSTransition')
    for (const a of t) a.finish()
    return t.length
  })
}

async function shot(browser, base, name, query, size) {
  const { page, errors } = await openGame(browser, base + query, size)
  await settle(page)
  await page.screenshot({ path: `${OUT}/${name}.png`, type: 'png' })
  const state = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
    mapOn: [...document.querySelectorAll('.mapbtn')].filter((b) => b.classList.contains('on')).map((b) => b.dataset.map),
    modeOn: [...document.querySelectorAll('.modebtn')].filter((b) => b.classList.contains('on')).map((b) => b.dataset.mode),
    menuH: document.getElementById('menu').getBoundingClientRect().height,
    winH: window.innerHeight,
  }))
  console.log(name, JSON.stringify(state), errors.length ? `ERRORS ${JSON.stringify(errors)}` : 'clean')
  await page.context().close()
  return state
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  const browser = await launchBrowser()
  const big = { width: 1600, height: 900 }
  const small = { width: 1280, height: 720 }
  // The one that finds the real breakages: below 620px the picker stacks, and
  // a 620x700 window is short enough that the panel has to scroll inside the
  // overlay. Both paths are one media query away from being unusable.
  const narrow = { width: 600, height: 700 }
  try {
    await shot(browser, server.url, 'menu-skyline', '', big)
    await shot(browser, server.url, 'menu-void', '?theme=void', big)
    await shot(browser, server.url, 'menu-skyline-720', '', small)
    await shot(browser, server.url, 'menu-void-720', '?theme=void', small)
    await shot(browser, server.url, 'menu-void-narrow', '?theme=void', narrow)
    // prefers-reduced-motion: the start button must stop pulsing and stay
    // fully lit, and the departure bar must stay readable without sweeping.
    await shot(browser, server.url, 'menu-skyline-reduced', '', { ...big, reducedMotion: 'reduce' })

    // ---- per-level, per-mode best-time strips ----------------------------
    // Seed three boards, reload so the boot paints from them, and read back the
    // strip on each route card. The default mode is NORMAL, so the strips must
    // show the `:normal` boards — the Skyline's 42.11 and the Void's 1:28.90 —
    // and NOT the `skyline:fun` time, which proves the board is scoped to the
    // rules and not just the level.
    {
      const { page, errors } = await openGame(browser, server.url, big)
      await page.evaluate(() => localStorage.setItem('skyline-courier:boards', JSON.stringify({
        'skyline:normal': [{ t: 42.11, mode: 'normal', level: 'skyline', cps: 3, date: '2026-07-26T00:00:00.000Z' }],
        'skyline:fun': [{ t: 31.5, mode: 'fun', level: 'skyline', cps: 3, date: '2026-07-26T00:00:00.000Z' }],
        'void:normal': [{ t: 88.9, mode: 'normal', level: 'void', cps: 4, date: '2026-07-26T00:00:00.000Z' }],
      })))
      await page.goto(server.url, { waitUntil: 'load' })
      await page.waitForFunction('window.__READY__ === true')
      await settle(page)
      const rec = await page.evaluate(() => {
        const g = (map) => {
          const r = document.querySelector(`.mapbtn[data-map="${map}"] [data-rec]`)
          return { has: r.classList.contains('has'), time: r.querySelector('.rectime').textContent, mode: r.querySelector('.recmode').textContent }
        }
        return { mode: localStorage.getItem('skyline-courier:mode') || 'normal', skyline: g('skyline'), void: g('void') }
      })
      console.log('records (normal) ->', JSON.stringify(rec), errors.length ? `ERRORS ${JSON.stringify(errors)}` : 'clean')
      await page.screenshot({ path: `${OUT}/menu-records.png`, type: 'png' })
      await page.context().close()
    }

    // ---- interaction: picking a mode must NOT start the run --------------
    const { page, errors } = await openGame(browser, server.url, big)
    await settle(page)
    await page.click('#mode-fun')
    const afterMode = await page.evaluate(() => ({
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      locked: !!document.pointerLockElement,
      modeOn: [...document.querySelectorAll('.modebtn.on')].map((b) => b.dataset.mode),
      stored: localStorage.getItem('skyline-courier:mode'),
      hudTag: document.getElementById('modetag').textContent,
    }))
    console.log('click mode-fun ->', JSON.stringify(afterMode))

    // ---- the third mode is real: picking HARDCORE must select it, persist,
    //      tag the HUD, and re-read the record strips to that mode's boards ---
    await page.click('#mode-hardcore')
    const afterHardcore = await page.evaluate(() => ({
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      locked: !!document.pointerLockElement,
      modeOn: [...document.querySelectorAll('.modebtn.on')].map((b) => b.dataset.mode),
      modeCards: document.querySelectorAll('.modebtn').length,
      stored: localStorage.getItem('skyline-courier:mode'),
      hudTag: document.getElementById('modetag').textContent,
      recModes: [...document.querySelectorAll('[data-rec] .recmode')].map((n) => n.textContent),
    }))
    console.log('click mode-hardcore ->', JSON.stringify(afterHardcore))

    // ---- interaction: opening the controls must NOT start the run --------
    await page.click('#keysbox > summary')
    const afterKeys = await page.evaluate(() => ({
      open: document.getElementById('keysbox').open,
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      locked: !!document.pointerLockElement,
    }))
    console.log('click controls ->', JSON.stringify(afterKeys))
    await settle(page)
    await page.screenshot({ path: `${OUT}/menu-skyline-open.png`, type: 'png' })

    // ---- interaction: picking the other map -> loading state, then reload -
    await page.click('.mapbtn[data-map="void"]')
    await page.waitForFunction('document.getElementById("overlay").classList.contains("loading")')
    await page.evaluate(() => new Promise((r) => setTimeout(r, 260)))
    await settle(page)
    await page.screenshot({ path: `${OUT}/menu-loading.png`, type: 'png' })
    await page.waitForFunction('window.__READY__ === true && document.documentElement.dataset.theme === "void"',
      null, { timeout: 30000 })
    const afterMap = await page.evaluate(() => ({
      url: location.search,
      theme: document.documentElement.dataset.theme,
      stored: localStorage.getItem('skyline-courier:theme'),
      storedMode: localStorage.getItem('skyline-courier:mode'),
      mapOn: [...document.querySelectorAll('.mapbtn.on')].map((b) => b.dataset.map),
      modeOn: [...document.querySelectorAll('.modebtn.on')].map((b) => b.dataset.mode),
      notes: [...document.querySelectorAll('[data-note]')].map((n) => n.textContent),
    }))
    console.log('click map void ->', JSON.stringify(afterMap))
    await settle(page)
    await page.screenshot({ path: `${OUT}/menu-after-switch.png`, type: 'png' })

    // ---- persistence across a plain reload (no ?theme=) ------------------
    await page.goto(server.url, { waitUntil: 'load' })
    await page.waitForFunction('window.__READY__ === true')
    const afterReload = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      mapOn: [...document.querySelectorAll('.mapbtn.on')].map((b) => b.dataset.map),
      modeOn: [...document.querySelectorAll('.modebtn.on')].map((b) => b.dataset.mode),
    }))
    console.log('bare reload ->', JSON.stringify(afterReload), errors.length ? `ERRORS ${JSON.stringify(errors)}` : 'clean')
    await settle(page)
    await page.screenshot({ path: `${OUT}/menu-void-persisted.png`, type: 'png' })

    // ---- harness hideChrome must still work ------------------------------
    const hidden = await page.evaluate(() => {
      document.getElementById('overlay').classList.add('hidden')
      document.getElementById('hud').style.display = 'none'
      const o = getComputedStyle(document.getElementById('overlay')).display
      return { overlayDisplay: o, hudDisplay: document.getElementById('hud').style.display }
    })
    console.log('hideChrome ->', JSON.stringify(hidden))
    await page.context().close()
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
