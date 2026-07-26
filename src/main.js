import * as THREE from 'three'
import { CollisionWorld } from './collision.js'
import { Player, TUNING, MODES, DEFAULT_MODE, setMode, getMode } from './player.js'
import { CameraRig } from './camera.js'
import { buildCourse } from './level.js'
import { buildVoidCourse } from './levels/void.js'
import { buildWorld } from './world.js'
import { Audio } from './audio.js'
import { Hud, formatTime } from './hud.js'
import { SpeedFX } from './fx/speed.js'
import { GrappleFX } from './fx/grapple.js'
import { VoidFX } from './fx/voidfx.js'
import { RenderPipeline } from './render/index.js'
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

function loadMode() {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v && MODES[v] ? v : DEFAULT_MODE
  } catch { return DEFAULT_MODE }        // private mode
}
setMode(loadMode())

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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

const player = new Player(collision, level.spawn)
player.anchors = level.anchors
const rig = new CameraRig(camera)
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
  best: loadBest(),
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

const KEY_MAP = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  ControlLeft: 'slide', ControlRight: 'slide', KeyC: 'slide',
}

window.addEventListener('keydown', (e) => {
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
    respawn()
    return
  }
  if (e.code === 'KeyP') {
    setPhotoMode(!photoMode)
    e.preventDefault()
    return
  }
  const k = KEY_MAP[e.code]
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
  const k = KEY_MAP[e.code]
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
    music.load()
  }
  music?.playMenu()
  // Clicking back in is also how you leave photo mode — reaching for P again
  // when you have a free cursor and the world in front of you is not obvious.
  if (photoMode) setPhotoMode(false)
  else canvas.requestPointerLock()
})

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas
  // Photo mode is the one way to be unlocked WITHOUT the overlay — that is the
  // whole point of it.
  hud.setOverlay(!locked && !photoMode)
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
  hud.setMode(getMode(), MODES)
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
  if (isBest) {
    run.best = run.time
    saveBest(run.time)
  }
  hud.holdToast(
    'route complete',
    `${formatTime(run.time)}${isBest ? '  — new best' : `   best ${formatTime(run.best)}`}   ·   R to run it again`,
  )
}

function resetRun() {
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

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && run.finished) resetRun()
})

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
  renderer.setSize(window.innerWidth, window.innerHeight)
  speedFX.setSize(window.innerWidth, window.innerHeight)
  pipeline.setSize(window.innerWidth, window.innerHeight)
})

// ------------------------------------------------------------- persistence

function loadBest() {
  const v = localStorage.getItem('skyline-courier:best')
  return v == null ? null : parseFloat(v)
}
function saveBest(t) {
  try { localStorage.setItem('skyline-courier:best', String(t)) } catch { /* private mode */ }
}

// --------------------------------------------------------------- debug API

// Exposed for the headless verification harness (docs/roadmap.md, later phase)
// and for driving the game from a browser console during development.
window.__game = {
  player, rig, run, level, camera, scene, renderer, input, keys, respawn, resetRun,
  // Exposed for the same reason the pipeline is: the continuous audio layer
  // (wind, gearbox, wall scrape) has no visible output at all, so without a
  // handle on it the only way to check it is to listen — which a headless
  // harness cannot do. `audio.update` also swallows its own exceptions by
  // design, so "no console error" is not evidence there either.
  audio,
  tick, TUNING, MODES, getMode, setMode: applyMode,
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
