import * as THREE from 'three'
import { CollisionWorld } from './collision.js'
import { Player, TUNING, MODES, DEFAULT_MODE, setMode, getMode } from './player.js'
import { CameraRig, DEFAULT_MOUSE_SENSITIVITY } from './camera.js'
import { buildCourse } from './level.js'
import { buildVoidCourse } from './levels/void.js'
import { buildWorld } from './world.js'
import { Audio } from './audio.js'
import { Hud, formatTime } from './hud.js'
import { SpeedFX } from './fx/speed.js'
import { GrappleFX } from './fx/grapple.js'
import { VoidFX } from './fx/voidfx.js'
import { RenderPipeline } from './render/index.js'
import { DEFAULT_QUALITY, QUALITY_LEVELS, QUALITY_NAMES, resolveQuality,
         LOOK_NAMES, readLook, setLook } from './render/quality.js'
import { Music } from './music.js'
import { selectTheme, getTheme, THEMES } from './theme.js'

/**
 * Bootstrap and the game loop.
 *
 * The loop runs a fixed-step simulation with a render interpolation-free
 * commit: movement at a variable step is how a parkour controller acquires
 * frame-rate-dependent jump heights, which is the kind of bug that only shows
 * up on someone else's machine.
 */

const FIXED_STEP = 1 / 120
const MAX_FRAME = 0.1

// ---------------------------------------------------------------- difficulty
//
// Applied before anything constructs a Player or reads a tuning constant, so
// the whole boot happens under one consistent rule set. NORMAL is the default
// for a first-time player because it is the truer parkour experience; FUN is
// one click away on the start overlay and is remembered thereafter.
const MODE_KEY = 'skyline-courier:mode'

/**
 * The leaderboard storage key, declared UP HERE with the other storage keys
 * rather than beside the board code at the bottom of the file, because module
 * init paints the menu's boards long before that point is reached.
 *
 * It used to live down there, and the boards were empty on every fresh load —
 * every time, silently, and correct the instant you touched the mode picker.
 * `const` is in its temporal dead zone until the declaration EXECUTES, so
 * `loadBoards()` at boot threw a ReferenceError reaching for this name, and its
 * `catch` — written for private-mode storage failures — swallowed the error and
 * returned `{}`. A rescue written for one failure quietly absorbed a different
 * one, and turned "the code is broken" into "you have no records yet".
 */
const BOARD_KEY = 'skyline-courier:boards'
// Up here for the same reason BOARD_KEY is, and it is not a coincidence: the
// boot paint reads BOTH, so a key declared beside its own code is a key in its
// temporal dead zone when the menu first draws.
const SIG_KEY = 'skyline-courier:sigs'

const MUSIC_KEY = 'skyline-courier:music'
const MUSIC_DEFAULT = 38          // matches Music's own starting volume
const SENSITIVITY_KEY = 'skyline-courier:mouse-sensitivity'
const SENSITIVITY_MIN = 0.0006
const SENSITIVITY_MAX = 0.0036
const MOVEMENT_KEY = 'skyline-courier:movement-scheme'
const MOVEMENT_SCHEMES = ['wasd', 'arrows', 'both']

function loadMusicVol() {
  try {
    const v = parseInt(localStorage.getItem(MUSIC_KEY), 10)
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : MUSIC_DEFAULT
  } catch { return MUSIC_DEFAULT }
}

let musicVol = loadMusicVol()

function loadSensitivity() {
  try {
    const v = parseFloat(localStorage.getItem(SENSITIVITY_KEY))
    return Number.isFinite(v)
      ? Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, v))
      : DEFAULT_MOUSE_SENSITIVITY
  } catch { return DEFAULT_MOUSE_SENSITIVITY }
}

function loadMovementScheme() {
  try {
    const v = localStorage.getItem(MOVEMENT_KEY)
    return MOVEMENT_SCHEMES.includes(v) ? v : 'both'
  } catch { return 'both' }
}

let mouseSensitivity = loadSensitivity()
let movementScheme = loadMovementScheme()

function loadMode() {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v && MODES[v] ? v : DEFAULT_MODE
  } catch { return DEFAULT_MODE }        // private mode
}
setMode(loadMode())

// ----------------------------------------------------------------- quality

/** Graphics quality level. See `src/render/quality.js` and `docs/lite-mode.md`. */
const QUALITY_KEY = 'skyline-courier:quality'

function loadQuality() {
  try {
    // `?quality=lite` first, and it does NOT persist — the harness has to be
    // able to render a level without leaving that level set for the next run,
    // and an evaluator wants to A/B by reloading rather than by remembering to
    // put it back. Same precedence rule the theme uses (src/theme.js).
    const q = new URLSearchParams(location.search).get('quality')
    if (q && QUALITY_LEVELS[q]) return q
    return resolveQuality(localStorage.getItem(QUALITY_KEY))
  } catch { return DEFAULT_QUALITY }       // private mode
}

let quality = loadQuality()

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
})
/**
 * The cap, not the ratio: `devicePixelRatio` is what the display asks for and
 * we only ever ask for less. At the default cap of 2 a HiDPI panel is drawing
 * four times the pixels of its CSS size, and on a fill-bound renderer that IS
 * the frame — which is why this is the first knob a quality level turns.
 */
function applyPixelRatio() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_LEVELS[quality].pixelRatioCap))
}
applyPixelRatio()
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.1, 1200)

// Theme is chosen ONCE, before anything that bakes a colour into a uniform,
// an IBL or a 33^3 grade LUT. `?theme=void` on the URL, then localStorage,
// then the shipped skyline. See src/theme.js.
const theme = selectTheme()
const world = buildWorld(scene, renderer, theme)

// ------------------------------------------------------------------- level

const collision = new CollisionWorld()
// The course is chosen by the theme, not independently of it: a level and the
// light it was authored under are one artistic decision, and letting them be
// mixed produces frames nobody designed. `?theme=void` therefore selects the
// void COURSE as well as the void lighting.
const level = theme.name === 'void' ? buildVoidCourse(collision) : buildCourse(collision)
scene.add(level.build())

// The layout this session's times will be set against, remembered before the
// menu paints anything — every board read below filters on it. See
// `courseSignature`. Only the loaded course can compute its own, so the map is
// updated one level at a time, as you visit them.
const courseSig = courseSignature(level)
try {
  const sigs = loadSigs()
  if (sigs[theme.name] !== courseSig) {
    sigs[theme.name] = courseSig
    localStorage.setItem(SIG_KEY, JSON.stringify(sigs))
  }
} catch { /* private mode */ }

const player = new Player(collision, level.spawn)
player.anchors = level.anchors
const rig = new CameraRig(camera)
rig.sensitivity = mouseSensitivity
const audio = new Audio()
const hud = new Hud()
// Wayfinding needs the camera (for bearing) and the level (for the next
// objective). Read-only on both. Without this the HUD still works, it just
// cannot point anywhere — and with an archipelago instead of a corridor,
// "which way" stopped being answerable from the geometry alone.
hud.setNav(camera, level)
// The void's energy beams: one instanced draw call, no colliders, and the only
// vertical landmarks in a course whose whole difficulty is reading height.
// See src/fx/voidfx.js. Themes that do not ask for them pay nothing.
const voidFX = theme.beams ? new VoidFX(scene) : null
const speedFX = new SpeedFX(scene)
speedFX.setSize(window.innerWidth, window.innerHeight)
const grappleFX = new GrappleFX(scene)
/** Built on first click, once an AudioContext legally exists. */
let music = null

// HDR pipeline: physical auto-exposure → Karis bloom → AgX + procedural
// grade LUT. The scene never touches the default framebuffer directly.
const pipeline = new RenderPipeline(renderer, scene, camera, {
  quality,
  // Both are partial overlays over the shipped defaults — see src/theme.js.
  // `grade` retints the LUT; `exposure` widens the metering window, without
  // which a near-black theme pins against the daylight floor and cannot get
  // dark at all.
  grade: theme.grade || undefined,
  exposure: theme.exposure || undefined,
  // `aerial` is the third overlay of the same shape, and it is what draws the
  // depth bands — see src/theme.js. Without it a dark theme's distant geometry
  // still fades into the shipped golden-hour haze.
  aerial: theme.aerial || undefined,
  sky: theme.sky
    ? { zenith: theme.sky.zenith, horizon: theme.sky.horizon,
        sunHaze: theme.sky.sun, cloud: theme.sky.deck,
        voidMode: !!theme.sky.voidMode }
    : undefined,
})
pipeline.setSize(window.innerWidth, window.innerHeight)

// ------------------------------------------------------------------- state

const run = {
  time: 0,
  started: false,
  finished: false,
  checkpointsHit: 0,
  respawn: level.spawn.clone(),
  respawnYaw: level.spawnYaw,
  // The best on THIS course under the rules booted with. Reloaded when the mode
  // changes (see `applyMode`) so the finish toast never compares against a time
  // set under different rules.
  best: bestTime(currentBoards(), theme.name, getMode()),
}
rig.yaw = level.spawnYaw

const input = {
  forward: 0,
  right: 0,
  jumpPressed: false,
  jumpHeld: false,
  dashPressed: false,
  grapplePressed: false,
  grappleHeld: false,
  sprint: false,
  slide: false,
}

const keys = new Set()

// ------------------------------------------------------------------ input

const WASD_MAP = {
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
}
const ARROW_MAP = {
  ArrowUp: 'fwd', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
}
const KEY_MAP = {
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  ControlLeft: 'slide', ControlRight: 'slide', KeyC: 'slide',
}

function mappedKey(code) {
  if (movementScheme !== 'arrows' && WASD_MAP[code]) return WASD_MAP[code]
  if (movementScheme !== 'wasd' && ARROW_MAP[code]) return ARROW_MAP[code]
  return KEY_MAP[code]
}

window.addEventListener('keydown', (e) => {
  // A browser shortcut is never a game action. CTRL+R reloads — it used to
  // respawn you first, on the way out — and CTRL+W closes the tab. Anything
  // held with CTRL or META belongs to the browser, so hand it straight over.
  // SHIFT is ours (sprint) and ALT is left alone deliberately: it opens menus
  // on some platforms and we do not bind it.
  if (e.ctrlKey || e.metaKey) return
  if (e.code === 'Space') {
    if (!input.jumpHeld) input.jumpPressed = true
    input.jumpHeld = true
    e.preventDefault()
    return
  }
  if (e.code === 'KeyQ' || e.code === 'KeyE') {
    if (!e.repeat) input.dashPressed = true
    e.preventDefault()
    return
  }
  if (e.code === 'KeyF') {
    if (!e.repeat) input.grapplePressed = true
    input.grappleHeld = true
    e.preventDefault()
    return
  }
  if (e.code === 'KeyR') {
    // AFTER A FINISH, R RESTARTS THE WHOLE RUN; during one it returns you to the
    // last checkpoint. Both used to be bound — in two separate listeners, both
    // of which fired, so a post-finish R respawned you at the finish AND reset
    // the run, in that order. It happened to end up in the right place, which
    // is the worst kind of working.
    if (run.finished) resetRun()
    else respawn()
    return
  }
  if (e.code === 'KeyM') {
    // THE MENU KEY. Ethan: "menu button being esc is awkward in full screen
    // mode" — and he is right, because ESCAPE is not ours. In fullscreen the
    // browser spends it on leaving fullscreen, so the one key that raised the
    // menu also threw away the window you were playing in. M just drops the
    // pointer lock, which raises the menu on its own (see pointerlockchange),
    // and fullscreen is untouched.
    document.exitPointerLock()
    e.preventDefault()
    return
  }
  if (e.code === 'KeyP') {
    setPhotoMode(!photoMode)
    e.preventDefault()
    return
  }
  const k = mappedKey(e.code)
  if (k) { keys.add(k); e.preventDefault() }
})

// --------------------------------------------------------------- photo mode
//
// Ethan, mid-playtest: "I wish I could take screenshots without going to menu
// so I can give you better feedback."
//
// Escape was the only way to free the cursor, and freeing the cursor raises the
// overlay straight over the exact frame he was trying to show me — so every bug
// report arrived as a screenshot of the menu with the evidence blurred behind
// it. That is a bug in the FEEDBACK LOOP, which makes it worth more than most
// bugs in the game.
//
// P frees the cursor, freezes the simulation and hides the HUD, and leaves the
// world on screen untouched. Click to go back to playing. Freezing matters as
// much as the cursor does: it means a mid-air frame can be photographed, and
// falling past the thing you wanted to report no longer loses it.
let photoMode = false

function setPhotoMode(on) {
  photoMode = on
  const h = document.getElementById('hud')
  if (h) h.style.display = on ? 'none' : ''
  if (on) {
    // Drop held keys, or the freeze captures a stuck input and the player
    // sprints off the moment the cursor comes back.
    keys.clear()
    input.jumpHeld = false
    input.grappleHeld = false
    document.exitPointerLock()
  } else {
    canvas.requestPointerLock()
  }
}

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { input.jumpHeld = false; return }
  if (e.code === 'KeyF') { input.grappleHeld = false; return }
  const k = mappedKey(e.code)
  if (k) keys.delete(k)
})

// Losing focus must not leave a key stuck down mid-run.
window.addEventListener('blur', () => {
  keys.clear()
  input.jumpHeld = false
  input.grappleHeld = false
})

function readInput() {
  input.forward = (keys.has('fwd') ? 1 : 0) - (keys.has('back') ? 1 : 0)
  input.right = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0)
  input.sprint = keys.has('sprint')
  input.slide = keys.has('slide')
}

// --------------------------------------------------------------- pointer

const canvas = renderer.domElement

hud.overlay.addEventListener('click', (e) => {
  // The picker cards and the controls disclosure live inside the overlay, whose
  // own click starts the run. Without this guard, choosing a difficulty (or
  // opening the key reference) would immediately grab the pointer and drop you
  // into the course you were still deciding about.
  if (e.target.closest('.modebtn, .mapbtn, [data-nostart]')) return
  audio.init()
  // Music has to be built after the AudioContext exists, and the context can
  // only be created from a real user gesture — so this is the earliest
  // possible moment, not a lazy choice.
  if (!music && audio.ctx) {
    music = new Music(audio.ctx, audio.master)
    // The graph is born here, long after the setting was read, so the stored
    // level is applied to it the moment it exists — otherwise the slider would
    // read one number and the first track would play at another.
    music.setVolume(musicVol / 100)
    music.load()
  }
  music?.playMenu()
  // Clicking back in is also how you leave photo mode — reaching for P again
  // when you have a free cursor and the world in front of you is not obvious.
  if (photoMode) setPhotoMode(false)
  else {
    // Same gesture takes the screen and the pointer. Fullscreen must be
    // requested from a user gesture, and this click is the only one there is.
    enterFullscreen()
    canvas.requestPointerLock()
  }
})

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas
  // Photo mode is the one way to be unlocked WITHOUT the overlay — that is the
  // whole point of it.
  hud.setOverlay(!locked && !photoMode)
  if (!locked) paintRestart()
  // Whatever raises the panel raises the MENU. Coming back from a run to the
  // records screen you left open ten minutes ago would hide the one control
  // that starts another one.
  if (locked) showPane('play')
  if (locked) {
    // A menu button keeps DOM focus after the click that dismissed the menu, so
    // an Enter mid-run would re-fire it — and on a map card that is a page
    // reload in the middle of someone's run. Drop focus the moment we lock.
    document.activeElement?.blur?.()
    if (!run.finished) music?.playGameplay()
  } else {
    keys.clear()
    input.jumpHeld = false
    input.grappleHeld = false
    music?.playMenu()
  }
})

document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) rig.look(e.movementX, e.movementY)
})

// Right mouse also dashes — reaching for Q mid-air while steering with the
// mouse is exactly the kind of hand contortion that breaks flow. Left click
// is deliberately NOT bound: it is the button used to enter pointer lock, so
// binding it means the click that starts the game also burns a dash charge.
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement !== canvas) return
  if (e.button === 2) input.dashPressed = true
})
canvas.addEventListener('contextmenu', (e) => e.preventDefault())

// ------------------------------------------------------------- mode picker

/**
 * Switch difficulty and start over.
 *
 * The reset is not optional. Mode changes the rules the *current* airborne
 * state was created under — a player mid-grapple in FUN who switches to NORMAL
 * would be flying on a chain link that no longer exists — and it changes what a
 * time means, so carrying a part-run across the boundary would silently corrupt
 * the split it eventually produces.
 */
function applyMode(name) {
  if (name === getMode()) return
  setMode(name)
  try { localStorage.setItem(MODE_KEY, getMode()) } catch { /* private mode */ }
  resetRun()
  // A new rule set means a different board: the toast must now compare against
  // this mode's best, and the menu strips re-read to that mode's records.
  run.best = bestTime(currentBoards(), theme.name, getMode())
  hud.setMode(getMode(), MODES)
  updateRecords()
}

for (const btn of document.querySelectorAll('.modebtn')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    applyMode(btn.dataset.mode)
  })
}
hud.setMode(getMode(), MODES)

// -------------------------------------------------------------- map picker

/**
 * Switch world.
 *
 * This one cannot be done live and there is no honest way to pretend otherwise:
 * the theme is baked into the IBL, a 33^3 grade LUT and every material during
 * boot (see the comment on `selectTheme`), so changing it means booting again.
 *
 * So the reload is made deliberate rather than hidden. The choice is persisted,
 * the picked card lights immediately, the panel dims behind a named status line
 * for a beat, and only then does the page go. The alternative — reloading on the
 * same tick — reads as the game crashing at the exact moment you touched it.
 *
 * The URL is updated alongside localStorage because `?theme=` outranks storage
 * on the next boot: leaving a stale param in the address bar would silently
 * undo the choice that was just made.
 */
const THEME_KEY = 'skyline-courier:theme'
// Lets the menu's accent follow the booted world without touching the HUD,
// which stays brass in both (it is an instrument panel, not chrome).
document.documentElement.dataset.theme = theme.name
hud.setMap(theme.name)
// Paint the best-time strips once at boot, for whichever mode is remembered.
updateRecords()

let switchingMap = false

function applyMap(name) {
  if (switchingMap || !THEMES[name] || name === theme.name) return
  switchingMap = true
  try { localStorage.setItem(THEME_KEY, name) } catch { /* private mode */ }
  hud.setMap(name)
  const note = document.querySelector('#loadnote .ltext')
  if (note) note.textContent = `entering ${THEMES[name].label}`
  hud.overlay.classList.add('loading')
  let url = location.href
  try {
    const u = new URL(location.href)
    u.searchParams.set('theme', name)
    u.searchParams.delete('level')      // the legacy alias, or it would win
    url = u.toString()
  } catch { /* non-URL context */ }
  // Long enough to be read as a departure, short enough not to be a wait.
  setTimeout(() => location.replace(url), 480)
}

for (const btn of document.querySelectorAll('.mapbtn')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    applyMap(btn.dataset.map)
  })
}

// ---------------------------------------------------------------- respawn

function respawn() {
  player.teleport(run.respawn)
  rig.yaw = run.respawnYaw
  rig.pitch = 0
  // Without this the auto-exposure meter smoothly adapts *across the cut*,
  // so a respawn from a dark void into daylight fades in like a dream
  // sequence instead of being instant.
  pipeline.resetExposure()
}

function checkTriggers() {
  // Checkpoints are generous spheres, not thin planes: a checkpoint you can
  // miss at speed is a checkpoint that punishes the thing the game rewards.
  for (let i = 0; i < level.checkpoints.length; i++) {
    const cp = level.checkpoints[i]
    if (cp.reached) continue
    if (player.position.distanceTo(cp.position) > cp.radius) continue

    cp.reached = true
    run.checkpointsHit++
    run.respawn.copy(cp.position).setY(cp.position.y + 0.2)
    run.respawnYaw = rig.yaw
    audio.checkpoint()
    if (run.checkpointsHit > 1) {
      hud.showToast(cp.label, `split ${formatTime(run.time)}`, run.time)
    }
  }

  if (!run.finished && level.finish && player.position.distanceTo(level.finish) < 5.0) {
    finishRun()
  }

  if (player.position.y < level.killY) respawn()
}

function finishRun() {
  run.finished = true
  audio.finish()
  const isBest = run.best == null || run.time < run.best
  // File it on this course's board for the mode it was run under, storing more
  // than the finish line shows so the record survives to feed a richer view.
  const boards = recordRun({
    t: run.time,
    mode: getMode(),
    level: theme.name,
    cps: run.checkpointsHit,
    // The DENOMINATOR travels with the run, because it is not a constant: the
    // courses have different parcel counts and both are still being extended,
    // so a board row that read "8" would silently change meaning the next time
    // a checkpoint is added. Stored per entry, "8/11" stays true forever.
    cpsTotal: level.checkpoints.length,
    // Which layout this was run on. Without it the entry is a number with no
    // course attached, which is what every pre-expansion record now is.
    sig: courseSig,
    date: new Date().toISOString(),
  })
  if (isBest) run.best = run.time
  // The menu is hidden now, but the run register's strips are repainted so the
  // new record is already there the instant Escape raises the panel again.
  updateRecords(currentBoards(boards))
  showFinish(isBest)
}

// ---------------------------------------------------------- the finish plate
//
// Ethan: "make a winning indication more present and visible to the user" and
// "need a way to reset round after beating".
//
// The finish used to be a HUD toast — the same furniture a checkpoint split
// uses, in a corner, at 11px. The biggest moment in the game was announcing
// itself in the vocabulary of its smallest one. This is a plate in the middle
// of the screen with the time at display size.
const finishEl = document.getElementById('finish')
const NUDGE_AFTER = 15000       // ms; Ethan asked for "like 15 seconds after winning"
let nudgeTimer = 0

function showFinish(isBest) {
  if (!finishEl) return
  // The last checkpoint's split is usually still on screen; two announcements
  // stacked on one moment read as a glitch.
  hud.clearToast()
  finishEl.querySelector('.ftime').textContent = formatTime(run.time)
  document.getElementById('fverdict').textContent =
    isBest ? 'new best' : `best ${formatTime(run.best)}`
  document.getElementById('fparcels').textContent =
    `${run.checkpointsHit}/${level.checkpoints.length} parcels`
  finishEl.classList.toggle('best', isBest)
  finishEl.classList.remove('nudge', 'hidden')
  // The key prompt is held back so it does not compete with the time for the
  // first read. It arrives once the moment has landed — and it has to arrive,
  // because R is not discoverable and ESCAPE was the only exit anyone found.
  clearTimeout(nudgeTimer)
  nudgeTimer = setTimeout(() => finishEl.classList.add('nudge'), NUDGE_AFTER)
}

function hideFinish() {
  hud.clearToast()
  clearTimeout(nudgeTimer)
  finishEl?.classList.add('hidden')
}

function resetRun() {
  // Clearing the plate is not cosmetic: without it the banner stayed up through
  // the reset, so pressing R looked like it had done nothing at all. That is
  // most of why the finish felt like it had no way out.
  hideFinish()
  for (const cp of level.checkpoints) cp.reached = false
  run.time = 0
  run.started = false
  run.finished = false
  run.checkpointsHit = 0
  run.respawn.copy(level.spawn)
  run.respawnYaw = level.spawnYaw
  player.teleport(level.spawn)
  rig.yaw = level.spawnYaw
  rig.pitch = 0
}

// ------------------------------------------------------------------- loop

let last = performance.now() / 1000
let accumulator = 0
let clock = 0

function frame() {
  requestAnimationFrame(frame)

  const now = performance.now() / 1000
  let dt = now - last
  last = now
  if (dt > MAX_FRAME) dt = MAX_FRAME    // never let a tab-switch teleport anyone

  tick(dt)
}

/**
 * One simulation + render tick at an explicit dt.
 *
 * Split out from the rAF driver so the game can be stepped deterministically
 * from outside — by the headless verification harness, or from the console
 * when debugging a movement bug frame by frame. rAF is throttled to nothing in
 * a backgrounded tab, so a harness that relied on it would silently measure
 * a game that was never running.
 */
function tick(dt) {
  clock += dt
  const now = clock

  readInput()

  // Photo mode freezes the SIMULATION only. Everything downstream of it — the
  // camera rig, the world, the render pipeline — keeps running below, so the
  // frame stays live and lit rather than becoming a paused black screen, and
  // the player simply stops moving. `accumulator` deliberately does not
  // advance either: banking up time while frozen would fire a burst of catch-up
  // sim steps the instant the cursor came back.
  accumulator += photoMode ? 0 : dt
  let steps = 0
  while (accumulator >= FIXED_STEP && steps < 16) {
    player.update(FIXED_STEP, input, rig.yaw, rig.pitch)
    // jumpPressed is an edge, consumed by the first sim step that sees it —
    // and ONLY by a sim step. Clearing it once per rendered frame instead
    // silently swallows the press whenever a frame is shorter than the fixed
    // step (any display above 120Hz, or any spare-capacity frame), which is
    // exactly the "jump sometimes does nothing" bug.
    input.jumpPressed = false
    input.dashPressed = false
    input.grapplePressed = false
    audio.handle(player.events)
    for (const e of player.events) {
      if (e.type === 'dash') speedFX.impulse(1.0)
      else if (e.type === 'airjump') speedFX.impulse(0.7)
      else if (e.type === 'grapple') speedFX.impulse(0.5)
      else if (e.type === 'grapplerelease') speedFX.impulse(0.8)
      else if (e.type === 'walljump') speedFX.impulse(0.55)
      else if (e.type === 'climb') speedFX.impulse(0.45)
      else if (e.type === 'land') speedFX.impulse(e.impact * 0.5)
      else if (e.type === 'slide') speedFX.impulse(0.35)
    }
    if (!run.finished) {
      if (!run.started && (player.speed > 0.5 || !player.grounded)) run.started = true
      if (run.started) run.time += FIXED_STEP
    }
    checkTriggers()
    accumulator -= FIXED_STEP
    steps++
  }

  speedFX.update(dt, player, camera)
  rig.shake = speedFX.shake
  rig.update(dt, player, input)
  // After the rig, so the line originates from this frame's camera pose and
  // does not lag a frame behind the view it is drawn into.
  grappleFX.update(dt, player, camera)
  // Reference speed for the wind bed: near the top of what is actually
  // reachable, so the effect keeps climbing through the fast part of a run.
  audio.update(player, TUNING.maxSpeed * 0.8)
  world.update(now, player.position)
  voidFX?.update(now)
  hud.update(run.time, {
    time: run.time,
    player,
    checkpointsHit: run.checkpointsHit,
    checkpointsTotal: level.checkpoints.length,
    finished: run.finished,
  })

  pipeline.render(dt)
  speedFX.render(renderer)
}

// ------------------------------------------------------------------ resize

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  // Re-read the cap: dragging the window between a HiDPI laptop panel and an
  // external 1x monitor changes devicePixelRatio without changing the level.
  applyPixelRatio()
  renderer.setSize(window.innerWidth, window.innerHeight)
  speedFX.setSize(window.innerWidth, window.innerHeight)
  pipeline.setSize(window.innerWidth, window.innerHeight)
})

/**
 * The one graphics-quality authority, used by both Settings and the debug API.
 *
 * Three only recomputes the canvas backing store when setSize runs. Changing
 * the pixel-ratio cap without this complete resize sequence updates a number
 * but not the live frame, which is why this must never be copied into a UI
 * handler piecemeal.
 */
function setQuality(name) {
  quality = resolveQuality(name)
  try { localStorage.setItem(QUALITY_KEY, quality) } catch { /* private mode */ }
  applyPixelRatio()
  renderer.setSize(window.innerWidth, window.innerHeight)
  speedFX.setSize(window.innerWidth, window.innerHeight)
  pipeline.setQuality(quality)
  pipeline.setSize(window.innerWidth, window.innerHeight)
  return quality
}

// ------------------------------------------------------------- persistence
//
// Per-level, per-mode leaderboards, in localStorage — there is no backend and
// none is wanted. A time is only comparable to another time set on the SAME
// course under the SAME rules: a Hardcore run up the Void and a Fun run across
// the Skyline are different games, and one board that mixed them would be worse
// than none. So every board is keyed `<level>:<mode>` and holds its own ranked
// list.
//
// This supersedes the old single `skyline-courier:best` scalar, which was
// level- and mode-agnostic — it would show a Skyline best over the Void. That
// key is left untouched rather than migrated (its value cannot be honestly
// placed on any one board), and nothing reads it now.
const BOARD_MAX = 5              // keep the top five per board; the strip shows the top one

/**
 * The COURSE SIGNATURE — what a time was actually set against.
 *
 * Ethan, 2026-07-27, the morning the big expansion shipped: "on map change
 * leaderboard needs to reset." He is right, and the reason is sharper than
 * housekeeping: his 47.98 was set on a course that no longer exists. Left on
 * the board it is not a record, it is a claim about a route nobody can run, and
 * every honest run on the new layout loses to it forever.
 *
 * DERIVED, NOT DECLARED. A version constant somebody has to remember to bump is
 * a version constant that will not get bumped — the expansion lane had no idea
 * a leaderboard existed. This hashes the things a time is actually run against:
 * where you start, where you finish, and every checkpoint between. A lane that
 * moves the route invalidates the board by moving the route.
 *
 * It deliberately does NOT hash the geometry. Re-texturing an island, fixing a
 * balustrade or relighting the sky does not change what the run IS, and a board
 * that reset on a paint job would train everyone to ignore it.
 */
function courseSignature(lv) {
  // FNV-1a over rounded coordinates. Rounded to 10 cm because float noise from
  // a refactor is not a route change; 10 cm of checkpoint drift is not either,
  // and anything that actually moves a checkpoint moves it much further.
  let h = 0x811c9dc5
  const eat = (v) => {
    if (!v) return
    for (const n of [v.x, v.y, v.z]) {
      const s = String(Math.round(n * 10))
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
    }
  }
  eat(lv.spawn)
  eat(lv.finish)
  for (const cp of lv.checkpoints) eat(cp.position)
  return (h >>> 0).toString(36)
}

/**
 * Signatures seen per level, so the records screen can judge the board of a
 * course that is not currently loaded.
 *
 * Only the loaded course can compute its own signature — the other course is
 * not built. Remembering the last one seen for each level means both boards can
 * be filtered on the records screen instead of only the one you happen to be
 * standing in.
 */
function loadSigs() {
  try { return JSON.parse(localStorage.getItem(SIG_KEY)) || {} }
  catch (err) { console.warn('course signatures unreadable:', err); return {} }
}

function boardKey(level, mode) { return `${level}:${mode}` }

function loadBoards() {
  try { return JSON.parse(localStorage.getItem(BOARD_KEY)) || {} }
  catch (err) {
    // Still degrades to an empty board — a player in private mode should get a
    // playable menu, not a crash — but it SAYS SO. The bare `catch` this
    // replaces hid a ReferenceError for the whole life of the feature (see
    // BOARD_KEY), and an empty board is indistinguishable from a new one, so
    // there was nothing to notice. Silence was the bug; the fallback was fine.
    console.warn('leaderboards unreadable, showing an empty board:', err)
    return {}
  }
}

/**
 * Every board, filtered to runs set on the layout that is live NOW.
 *
 * Retired entries are FILTERED, NEVER DELETED — they stay in storage exactly as
 * written. If a course is ever reverted, or a signature turns out to be too
 * eager, the runs are still there; a leaderboard that quietly destroys somebody's
 * history to tidy itself up is worse than one that shows a stale number.
 *
 * An entry with no `sig` at all predates this and is retired by definition: it
 * was set before the expansion, on a course that is now provably different.
 */
function currentBoards(raw = loadBoards(), sigs = loadSigs()) {
  const out = {}
  for (const [k, list] of Object.entries(raw)) {
    const want = sigs[k.split(':')[0]]
    out[k] = want ? list.filter((e) => e.sig === want) : list
  }
  return out
}

/** How many runs are being held back as set on an older layout. */
function retiredCount(raw = loadBoards(), sigs = loadSigs()) {
  let n = 0
  for (const [k, list] of Object.entries(raw)) {
    const want = sigs[k.split(':')[0]]
    if (want) n += list.filter((e) => e.sig !== want).length
  }
  return n
}

/** One board's ranked entries, fastest first. Always an array, never null. */
function boardList(boards, level, mode) {
  return boards[boardKey(level, mode)] || []
}

/** Best (lowest) time on one board, or null if it has never been run. */
function bestTime(boards, level, mode) {
  const list = boardList(boards, level, mode)
  return list.length ? list[0].t : null
}

/**
 * File a finished run onto its board and return the updated boards.
 *
 * The entry stores more than the strip shows — time, mode, level, checkpoints
 * and an ISO date — so a richer board (splits, dated history) can be built later
 * without a data migration.
 */
function recordRun(entry) {
  const boards = loadBoards()
  const k = boardKey(entry.level, entry.mode)
  const list = boards[k] || (boards[k] = [])
  list.push(entry)
  list.sort((a, b) => a.t - b.t)
  // Trimmed PER LAYOUT, not across the whole list. A flat top-five would let
  // five untouchable times from the old course evict every run on the new one,
  // so the board would show nothing you could actually beat — which is the
  // exact failure this feature exists to prevent, arriving through the back
  // door. Each layout keeps its own five.
  const kept = new Map()
  boards[k] = list.filter((e) => {
    const n = (kept.get(e.sig) || 0) + 1
    kept.set(e.sig, n)
    return n <= BOARD_MAX
  })
  try { localStorage.setItem(BOARD_KEY, JSON.stringify(boards)) }
  catch { /* private mode */ }
  return boards
}

/**
 * Repaint the menu's best-time strips for the mode currently picked.
 *
 * Both route cards are always on screen regardless of which world is booted, so
 * both are looked up — the other world's board lives in the same storage even
 * though its course is not loaded.
 */
function updateRecords(boards = currentBoards()) {
  const mode = getMode()
  // Whole ranked lists, not just the leader: the card shows the record in its
  // strip and the runs that lost to it underneath, and both come off the same
  // array. `boardList` never returns null, so the HUD has no empty-board case.
  hud.setRecords(
    { skyline: boardList(boards, 'skyline', mode), void: boardList(boards, 'void', mode) },
    MODES[mode]?.label || mode,
  )
}

// ------------------------------------------------------- the records screen
//
// A separate screen rather than more of the card strip, because six boards is
// more than a card can hold and the interesting question is comparative: how
// the same route reads under a different cuff. The strip on the menu card stays
// — it answers "what is my time here", which is a glance, not a read.
//
// `recordsMode` is deliberately NOT `getMode()`. It is which board you are
// looking at, and reading the Hardcore board must not re-rule the run you are
// about to start.
let recordsMode = getMode()

// Read off the rules row in the DOM rather than restated here, so the two
// cannot drift: the menu is the thing the player learned the order from.
const MODE_ORDER = [...document.querySelectorAll('.modebtn')]
  .map((b) => b.dataset.mode)
  .filter((k) => MODES[k])

function paintRecordsScreen() {
  hud.renderRecords({
    mode: recordsMode,
    // Tabs in the menu's order — FUN, NORMAL, HARDCORE, ascending — not the
    // order the MODES table happens to declare them in. The player has already
    // learned that row on the way in; a second, different order for the same
    // three things is a small lie about which one is harder.
    modes: MODE_ORDER.map((key) => ({ key, label: MODES[key].label || key })),
    // Labels come from the theme descriptors, so the screen calls the world
    // whatever the world calls itself — the reason the menu card spent a day
    // saying "The Void" is that its name was written in a second place.
    levels: Object.keys(THEMES).map((key) => ({ key, label: THEMES[key].label || key })),
    boards: currentBoards(),
    retired: retiredCount(),
  }, (key) => { recordsMode = key; paintRecordsScreen() })
}

/**
 * Show one face of the panel: 'play', 'board' or 'settings'.
 *
 * Pane switching lives HERE rather than on the Hud, where the records swap it
 * replaces used to live. It is menu chrome — class toggles on elements the HUD
 * has no other business with — and the Hud is instrumentation for a running
 * player. Moving it also freed this change from a lease the overdrive lane
 * holds on src/hud.js, which is the kind of nudge that usually means the
 * boundary was wrong to begin with.
 */
function paintPane(name) {
  for (const pane of document.querySelectorAll('.mpane')) {
    pane.classList.toggle('hidden', pane.dataset.pane !== name)
  }
  const restartBtn = document.getElementById('restart')
restartBtn?.addEventListener('click', () => {
  resetRun()
  paintRestart()
})

/** The restart button only exists once there is something to restart. */
function paintRestart() {
  restartBtn?.classList.toggle('hidden', !run.started && !run.finished)
}

for (const tab of document.querySelectorAll('.mtab')) {
    tab.setAttribute('aria-selected', tab.dataset.pane === name ? 'true' : 'false')
  }
}

let currentPane = 'play'

function showPane(name) {
  if (currentPane === 'settings' && name !== 'settings') cancelSettingsEdit()
  if (name === 'board') {
    // Re-read on every open, never cached: a run filed since the last look is
    // the only reason to be on this pane at all.
    recordsMode = getMode()
    paintRecordsScreen()
  }
  if (name === 'settings' && currentPane !== 'settings') beginSettingsEdit()
  currentPane = name
  paintPane(name)
}

const restartBtn = document.getElementById('restart')
restartBtn?.addEventListener('click', () => {
  resetRun()
  paintRestart()
})

/** The restart button only exists once there is something to restart. */
function paintRestart() {
  restartBtn?.classList.toggle('hidden', !run.started && !run.finished)
}

for (const tab of document.querySelectorAll('.mtab')) {
  tab.addEventListener('click', () => showPane(tab.dataset.pane))
}
showPane('play')

// ------------------------------------------------------------------ settings
//
// Every setting except LOOK is edited as one transaction. Sliders preview
// because volume and sensitivity cannot be judged without hearing/feeling
// them; leaving the pane restores the snapshot. Only Apply persists.

const FS_KEY = 'skyline-courier:fullscreen'
let fullscreenOnRun = (() => {
  try { return localStorage.getItem(FS_KEY) !== '0' } catch { return true }
})()

const fsBtn = document.getElementById('set-fs')
const applySettingsBtn = document.getElementById('settings-apply')
const settingsState = document.getElementById('settings-state')
let settingsEdit = null
let paintMovementControl = () => {}
let paintQualityControl = () => {}

function activeSettings() {
  return {
    fullscreen: fullscreenOnRun,
    music: musicVol,
    sensitivity: mouseSensitivity,
    movement: movementScheme,
    quality,
  }
}

function settingsDiffer(a, b) {
  return a.fullscreen !== b.fullscreen
    || a.music !== b.music
    || a.sensitivity !== b.sensitivity
    || a.movement !== b.movement
    || a.quality !== b.quality
}

function paintSettingsState() {
  const dirty = !!settingsEdit && settingsDiffer(settingsEdit.staged, settingsEdit.base)
  applySettingsBtn?.toggleAttribute('disabled', !dirty)
  if (settingsState) {
    settingsState.textContent = dirty ? 'unapplied changes' : 'all changes applied'
    settingsState.dataset.dirty = dirty ? 'true' : 'false'
  }
}

function paintFsBtn() {
  if (!fsBtn) return
  const on = settingsEdit?.staged.fullscreen ?? fullscreenOnRun
  fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false')
  fsBtn.textContent = on ? 'on' : 'off'
}
paintFsBtn()

fsBtn?.addEventListener('click', () => {
  if (!settingsEdit) beginSettingsEdit()
  settingsEdit.staged.fullscreen = !settingsEdit.staged.fullscreen
  paintFsBtn()
  paintSettingsState()
})

// ------------------------------------------------------------------- music
//
// Ethan: "I think the music should be adjustable as a slider in settings for
// volume." Stored 0..100 and applied as 0..1, because the number on the row is
// the thing being remembered and a stored float would round-trip badly.
//
// The music graph does not exist until the first click (an AudioContext needs a
// gesture), so this both applies live when there IS a graph and is re-applied
// at construction when there is not — see where Music is built.
const musicSlider = document.getElementById('set-music')
const musicVal = document.getElementById('set-music-val')

function applyMusicVol(v, persist) {
  musicVol = Math.min(100, Math.max(0, v | 0))
  if (musicVal) musicVal.textContent = `${musicVol}`
  // The lit portion of the track. CSS cannot read an input's value, so the fill
  // is handed to it as a custom property (see `.slider` in index.html).
  musicSlider?.style.setProperty('--v', `${musicVol / 100}`)
  music?.setVolume(musicVol / 100)
  if (persist) {
    try { localStorage.setItem(MUSIC_KEY, `${musicVol}`) } catch { /* private mode */ }
  }
}

if (musicSlider) {
  musicSlider.value = `${musicVol}`
  // Preview follows the drag; Apply is the only persistence edge.
  musicSlider.addEventListener('input', () => {
    if (!settingsEdit) beginSettingsEdit()
    settingsEdit.staged.music = +musicSlider.value
    applyMusicVol(settingsEdit.staged.music, false)
    paintSettingsState()
  })
}
applyMusicVol(musicVol, false)

// ------------------------------------------------------------- mouse input
//
// Stored in the same local browser settings plane as music. The rig reads its
// sensitivity on every locked mousemove, so an `input` event changes the very
// next look delta rather than waiting for a reload or a new run.
const sensitivitySlider = document.getElementById('set-sensitivity')
const sensitivityVal = document.getElementById('set-sensitivity-val')

function applySensitivity(v, persist) {
  mouseSensitivity = Math.min(SENSITIVITY_MAX, Math.max(SENSITIVITY_MIN, v))
  rig.sensitivity = mouseSensitivity
  if (sensitivityVal) sensitivityVal.textContent = mouseSensitivity.toFixed(4)
  sensitivitySlider?.style.setProperty(
    '--v',
    `${(mouseSensitivity - SENSITIVITY_MIN) / (SENSITIVITY_MAX - SENSITIVITY_MIN)}`,
  )
  if (persist) {
    try { localStorage.setItem(SENSITIVITY_KEY, mouseSensitivity.toFixed(4)) } catch { /* private mode */ }
  }
}

if (sensitivitySlider) {
  sensitivitySlider.value = `${mouseSensitivity}`
  sensitivitySlider.addEventListener('input', () => {
    if (!settingsEdit) beginSettingsEdit()
    settingsEdit.staged.sensitivity = +sensitivitySlider.value
    applySensitivity(settingsEdit.staged.sensitivity, false)
    paintSettingsState()
  })
}
applySensitivity(mouseSensitivity, false)

/**
 * Take the screen for the run.
 *
 * Requested from the same click that takes the pointer, because a fullscreen
 * request needs a user gesture and that click is the only one there is. It is
 * allowed to fail — some browsers and some embeds refuse — and failing must not
 * cost you the run, so the rejection is swallowed and the pointer lock proceeds
 * either way.
 */
function enterFullscreen() {
  if (!fullscreenOnRun || document.fullscreenElement) return
  document.documentElement.requestFullscreen?.().catch(() => { /* refused; play windowed */ })
}

/** Build a segmented control, remembering which segment is live. */
function segControl(hostId, names, get, set, label = (n) => n) {
  const host = document.getElementById(hostId)
  if (!host) return () => {}
  const paint = () => {
    for (const b of host.children) b.setAttribute('aria-pressed', b.dataset.v === get() ? 'true' : 'false')
  }
  for (const n of names) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'seg'
    b.dataset.v = n
    b.dataset.nostart = ''
    b.textContent = label(n)
    b.addEventListener('click', () => { set(n); paint() })
    host.append(b)
  }
  paint()
  return paint
}

paintQualityControl = segControl('set-quality', QUALITY_NAMES, () => {
  return settingsEdit?.staged.quality ?? quality
}, (n) => {
  if (!settingsEdit) beginSettingsEdit()
  settingsEdit.staged.quality = resolveQuality(n)
  paintSettingsState()
})

// LOOK changes what the geometry is generated from, which happens once at boot
// — so it reloads, exactly like a route change, and says so on the row rather
// than appearing to do nothing until you next start the game.
segControl('set-look', LOOK_NAMES, () => readLook(), (n) => {
  if (n === readLook()) return
  setLook(n)
  location.reload()
}, (n) => (n === 'no-foliage' ? 'no foliage' : n))

// Directional bindings are the only part of the control vocabulary this
// setting changes. Clearing held actions on a switch prevents a key accepted
// under the previous scheme from remaining stuck after it becomes disabled.
const movementKeys = document.getElementById('movement-keys')

function setMovementScheme(name) {
  movementScheme = MOVEMENT_SCHEMES.includes(name) ? name : 'both'
  keys.clear()
  input.forward = 0
  input.right = 0
  if (movementKeys) {
    movementKeys.textContent = movementScheme === 'wasd'
      ? 'WASD'
      : movementScheme === 'arrows' ? 'ARROW KEYS' : 'WASD / ARROW KEYS'
  }
  try { localStorage.setItem(MOVEMENT_KEY, movementScheme) } catch { /* private mode */ }
}

paintMovementControl = segControl(
  'set-movement',
  MOVEMENT_SCHEMES,
  () => settingsEdit?.staged.movement ?? movementScheme,
  (name) => {
    if (!settingsEdit) beginSettingsEdit()
    settingsEdit.staged.movement = MOVEMENT_SCHEMES.includes(name) ? name : 'both'
    paintSettingsState()
  },
  (n) => (n === 'wasd' ? 'WASD' : n === 'arrows' ? 'Arrows' : 'Both'),
)
setMovementScheme(movementScheme)

function paintSettingsControls() {
  const shown = settingsEdit?.staged ?? activeSettings()
  if (musicSlider) musicSlider.value = `${shown.music}`
  if (sensitivitySlider) sensitivitySlider.value = `${shown.sensitivity}`
  applyMusicVol(shown.music, false)
  applySensitivity(shown.sensitivity, false)
  paintFsBtn()
  paintMovementControl()
  paintQualityControl()
  paintSettingsState()
}

function beginSettingsEdit() {
  const base = activeSettings()
  settingsEdit = { base, staged: { ...base } }
  paintSettingsControls()
}

function cancelSettingsEdit() {
  if (!settingsEdit) return
  const base = settingsEdit.base
  settingsEdit = { base: { ...base }, staged: { ...base } }
  // Undo slider previews. The non-slider settings were never applied.
  applyMusicVol(base.music, false)
  applySensitivity(base.sensitivity, false)
  paintSettingsControls()
  settingsEdit = null
}

function applySettingsEdit() {
  if (!settingsEdit || !settingsDiffer(settingsEdit.staged, settingsEdit.base)) return
  const next = { ...settingsEdit.staged }

  fullscreenOnRun = next.fullscreen
  try { localStorage.setItem(FS_KEY, fullscreenOnRun ? '1' : '0') } catch { /* private mode */ }
  applyMusicVol(next.music, true)
  applySensitivity(next.sensitivity, true)
  setMovementScheme(next.movement)
  // Quality goes through the exact same complete authority as __game.
  setQuality(next.quality)

  const base = activeSettings()
  settingsEdit = { base, staged: { ...base } }
  paintSettingsControls()
}

applySettingsBtn?.addEventListener('click', applySettingsEdit)

// Escape while browsing Settings means Cancel. Pointer-lock Escape still
// raises the menu through pointerlockchange, where no edit exists yet.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || currentPane !== 'settings') return
  cancelSettingsEdit()
  showPane('play')
})

// ------------------------------------------------------- the CTRL+W problem
//
// Ethan: "ctrl W just closed the tab for me we should fix". CTRL+W cannot be
// blocked — it is reserved by the browser and never reaches the page.
//
// The first attempt at mitigation was a `beforeunload` guard during a run, and
// it was WRONG: beforeunload cannot tell a close from a refresh, so it also
// blocked reloading the page ("hmm wont let me refresh page"). Guarding against
// a rare accident by taxing a common deliberate action is a bad trade, and it
// is gone.
//
// What is left is the part that actually helps: C is the advertised slide key
// (see KEY_MAP and the controls table), so the common input is no longer
// CTRL+W. And the handlers below ignore anything held with CTRL or META, so a
// browser shortcut never doubles as a game action — CTRL+R used to respawn you
// on its way to reloading.

// --------------------------------------------------------------- debug API

// Exposed for the headless verification harness (docs/roadmap.md, later phase)
// and for driving the game from a browser console during development.
window.__game = {
  player, rig, run, level, camera, scene, renderer, input, keys, respawn, resetRun,
  // The far-band impostor layer's own accounting — instances, cards, the
  // apparent ruins those cards carry, the measured clearance from the play
  // volume, and how long the atlas bake took. All of it is invisible in a
  // screenshot, and the bake time in particular is a first-frame cost that
  // nothing else in the harness can see.
  backdrop: world.backdrop,
  // Exposed for the same reason the pipeline is: the continuous audio layer
  // (wind, gearbox, wall scrape) has no visible output at all, so without a
  // handle on it the only way to check it is to listen — which a headless
  // harness cannot do. `audio.update` also swallows its own exceptions by
  // design, so "no console error" is not evidence there either.
  audio,
  tick, TUNING, MODES, getMode, setMode: applyMode,
  getSensitivity: () => rig.sensitivity,
  setSensitivity(v) {
    applySensitivity(+v, true)
    if (sensitivitySlider) sensitivitySlider.value = `${mouseSensitivity}`
    return rig.sensitivity
  },
  getMovementScheme: () => movementScheme,
  setMovementScheme,
  /**
   * Graphics quality. `__game.setQuality('lite' | 'balanced' | 'high')`.
   *
   * Exposed rather than menu-driven on purpose (see the note by QUALITY_KEY):
   * this is the evaluation handle and the seam a settings UI will call. It
   * takes effect on the next frame — the pixel-ratio change resizes the canvas
   * and the tap counts recompile one shader, both synchronously.
   */
  QUALITY_LEVELS, QUALITY_NAMES,
  getQuality: () => quality,
  setQuality,
  // Exposed so render passes can be toggled from the console when bisecting a
  // visual bug. Finding which pass owns an artifact by turning them off one at
  // a time is far faster than reading four shaders.
  pipeline,
  /** Advance `frames` fixed frames without waiting on rAF. */
  drive(frames, dt = 1 / 60) {
    for (let i = 0; i < frames; i++) tick(dt)
  },
  /** Press a key for the harness: hold('fwd'), hold('sprint'), release('fwd'). */
  hold: (k) => keys.add(k),
  release: (k) => keys.delete(k),
  jump() { input.jumpPressed = true; input.jumpHeld = true },
}

// ------------------------------------------------- headless capture hooks

const _shotPos = new THREE.Vector3()

/**
 * Park the game on a named pose (see `tools/shots.mjs`).
 *
 * The harness calls this once per pumped frame rather than once per shot: a
 * mid-air pose left to itself falls for the whole pump and lands somewhere
 * else, so the pose has to be re-asserted, not merely set. Re-applying is
 * cheap and idempotent, and because velocity is restored too, the rig's
 * speed-driven FOV settles where it would in play instead of at a standstill.
 *
 * `shot` is either a table entry or the name of one in `window.__SHOTS__`,
 * which the harness injects — the table stays in tools/ so shipped code carries
 * no shot data.
 */
window.__SHOT__ = function (shot, reset = false) {
  const s = typeof shot === 'string' ? (window.__SHOTS__ || {})[shot] : shot
  if (!s || !s.pos) throw new Error(`__SHOT__: unknown shot ${JSON.stringify(shot)}`)

  _shotPos.set(s.pos[0], s.pos[1], s.pos[2])
  player.teleport(_shotPos)                       // also clears wall/slide state
  if (s.vel) player.velocity.set(s.vel[0], s.vel[1], s.vel[2])

  rig.yaw = s.yaw
  rig.pitch = s.pitch || 0
  // Zero the transient springs. They are driven by events that never happened
  // in a teleported frame, and a capture that inherits a landing dip from the
  // previous shot is a capture that cannot be compared with the next one.
  rig.roll = 0; rig.rollVel = 0
  rig.dip = 0; rig.dipVel = 0
  rig.punch = 0; rig.shake = 0; rig.slideEase = 0
  rig.bob.set(0, 0, 0)
  run.started = false                             // keep the HUD timer at zero

  // Only on the first application. The exposure meter must not adapt across a
  // cut, exactly as on respawn; after this it converges over the pumped frames.
  // Rewinding the clock and the accumulator matters just as much: every
  // time-driven effect in the world (motes, water, foliage sway) is a function
  // of `clock`, so without this the same shot captured twice differs by
  // however long the page took to boot — and a harness whose output changes
  // run to run cannot be used to detect that a change altered the picture.
  if (reset) {
    clock = 0
    accumulator = 0
    pipeline.resetExposure()
  }
  return s
}

// Set last, after one full tick + render has already happened below, so a
// harness that waits on this flag is waiting for a drawn frame, not for module
// evaluation.
frame()
window.__READY__ = true
