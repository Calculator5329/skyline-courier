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
 * `hideChrome()`. So the menu gets its own shot set, over both themes and at
 * both a desktop and a 1280x720 laptop, plus the three behaviours that are
 * easy to break and invisible in a screenshot:
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

async function shot(browser, base, name, query, size) {
  const { page, errors } = await openGame(browser, base + query, size)
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
  try {
    await shot(browser, server.url, 'menu-skyline', '', big)
    await shot(browser, server.url, 'menu-void', '?theme=void', big)
    await shot(browser, server.url, 'menu-skyline-720', '', small)
    await shot(browser, server.url, 'menu-void-720', '?theme=void', small)

    // ---- interaction: picking a mode must NOT start the run --------------
    const { page, errors } = await openGame(browser, server.url, big)
    await page.click('#mode-fun')
    const afterMode = await page.evaluate(() => ({
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      locked: !!document.pointerLockElement,
      modeOn: [...document.querySelectorAll('.modebtn.on')].map((b) => b.dataset.mode),
      stored: localStorage.getItem('skyline-courier:mode'),
      hudTag: document.getElementById('modetag').textContent,
    }))
    console.log('click mode-fun ->', JSON.stringify(afterMode))

    // ---- interaction: opening the controls must NOT start the run --------
    await page.click('#keysbox > summary')
    const afterKeys = await page.evaluate(() => ({
      open: document.getElementById('keysbox').open,
      overlayVisible: !document.getElementById('overlay').classList.contains('hidden'),
      locked: !!document.pointerLockElement,
    }))
    console.log('click controls ->', JSON.stringify(afterKeys))
    await page.screenshot({ path: `${OUT}/menu-skyline-open.png`, type: 'png' })

    // ---- interaction: picking the other map -> loading state, then reload -
    await page.click('.mapbtn[data-map="void"]')
    await page.waitForFunction('document.getElementById("overlay").classList.contains("loading")')
    await page.evaluate(() => new Promise((r) => setTimeout(r, 260)))
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
