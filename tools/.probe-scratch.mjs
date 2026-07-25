// Scratch: dump all console output during load, plus the exposure scalar.
import { DEFAULTS, REPO, glRenderer, hideChrome, launchBrowser, openGame, pumpShot, startStaticServer } from './harness.mjs'
import { resolve } from 'node:path'

const server = await startStaticServer(resolve(REPO, 'dist'), 5290)
const browser = await launchBrowser()
const context = await browser.newContext({ viewport: { width: 800, height: 450 }, deviceScaleFactor: 1 })
const page = await context.newPage()
page.on('console', (m) => console.log(`[${m.type()}] ${m.text().slice(0, 3000)}`))
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))
await page.addInitScript(() => { window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {} })
await page.goto(server.url, { waitUntil: 'load' })
await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
console.log('READY')
await browser.close()
await server.close()
