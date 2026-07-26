# Changelog

## 2026-07-25 — the Void gets a void: sky, atmosphere, exposure, energy beams

The void theme rendered, and measured as uniform violet murk: `lum 77.8,
p50 69.7, clip lo 0%` against `docs/art-direction-void.md` §2's `28-55 /
22-45 / 2-8%`. Four separate causes, all found by measuring rather than by
looking.

- **`src/render/skygrad.js` — a void mode in the shared gradient.** The dome
  was still painting a lit CLOUD DECK under a bright horizon band, so the
  theme's background was a golden-hour sky wearing a violet coat. `scSkyVoid`
  is declared inside the shared include, so the dome, the aerial perspective's
  inscatter and `scene.fog` switch together and the single-evaluation property
  the file exists for survives. `scVoidGradient` is a different shape, not the
  old one with darker inputs: no deck, no disc, no aureole, and one smooth
  monotone ramp over 130 degrees of dome so there is no h at which the
  derivative spikes and therefore no horizon LINE (§3).
- **`src/render/index.js` — the haze now gets the theme's sky.** `options.sky`
  reached the IBL and the dome and *not* the aerial perspective, which kept
  `skygrad.js`'s module defaults: a theme could repaint the whole background
  and still have every distant surface fade into golden-hour cream. Also adds
  `options.aerial`, the third per-theme overlay alongside `grade` and
  `exposure`, which is what draws §5's three depth bands.
- **`src/render/exposure.js` — `compensation`, `tapClamp` and `horizonBias`
  are per-theme, and three of the four were being silently dropped.**
  `src/theme.js` had been setting `compensation` and `horizonBias` since the
  theme landed; `AutoExposure` read neither. That mattered more than it
  sounds: auto-exposure places the metered average at one fixed display value
  whatever the scene luminance is, so with `compensation` inert the only lever
  anyone had was dimming the lights, and dimming the lights makes the meter
  open up and hand back the same mid-grey frame. That is the whole mechanism
  behind the murk.
- **`src/theme.js` — the void's exposure is PINNED (`minEV == maxEV`).**
  `tools/evprobe.mjs` (new) reads the metered EV out of the 1x1 adaptation
  target: on the void course it came back between -2.35 and -4.34 depending
  on the shot, which is two stops of disagreement about how bright the same
  world is, driven by how much geometry happens to be in frame. There is no
  sun here and no indoors, so the honest range of scene luminance is zero
  stops and anything the meter does is measuring composition. `tapClamp` also
  drops 8.0 -> 0.6: at 8.0 a beam swinging into frame is worth seven stops of
  extra vote per texel and the image visibly stops down as you run past a
  landmark. Measured drift over 90 frames is now 0.000 on all eleven shots.
- **`src/fx/voidfx.js` (new) — §4.4's energy beams.** Twelve thin red/magenta
  columns, instanced, one draw call, no colliders (volumetric light, like the
  motes and the grapple line). Cores authored at 30-70 in linear light so they
  clear the 0.78 bloom threshold after a two-stop-down exposure — the apparent
  width is bloom, and widening the quad is the one change that would destroy
  the effect. They billboard about the WORLD Y axis only, so a vertical
  landmark stays vertical when the player pitches up, and they carry their own
  extinction term because additive geometry never reaches the aerial
  perspective and a set of landmarks immune to fog collapses §5's three bands
  back into one.
- **`src/world.js` — motes cluster on the beams.** §4.5 asks for dust "denser
  near crystals and beams". In a near-black scene that is not decoration: dust
  with no light on it is invisible, so an even spread spends most of its
  budget on nothing. 55% of the void's motes are bound to a beam site, and the
  sites come from `voidfx.js` rather than being reinvented.

Measured, void, 1600x900, all eleven shots (before -> after, terrace):
`lum 77.7 -> 33.7`, `p50 69.7 -> 25.5`, `p99 241.3 -> 245.3`, `p1 4.7 -> 1.3`,
`clip lo 0% -> 3.7%`, `sat 0.59 -> 0.83`. Across the set: `p50` in §2's band
on 9 of 11 shots (was 0), `lum` on 8 of 11 (was 0), `sat > 0.45` on 11 of 11,
`p99 - p1 > 200` on 9 of 11. The shots still short are short of `p99` and
`clip hi`, and both are the same gap: they contain no emissive. Crystals,
sigil rings and rune inlays are §4.1-4.3 and are not in this change.

`skyline` is byte-identical where it matters: `closeup` is `lum 110.6,
sat 0.81, p1/p50/p99 19.9/116.6/185.3` before and after, draw calls unchanged,
and `bash tools/ship-gate.sh` exits 0.

`tools/shotset.mjs` now prints `dyn` (p99 - p1) beside `spread` (the 3x3
region spread). §2 writes "spread (p99-p1)" and then quotes the region numbers
next to it, which sets a >200 target against a statistic that would need a
ninth of the frame to average pure white. Printing both is cheaper than
arguing about which one a target meant.

## 2026-07-25 — the underpass left flank was passable

Reported: *"at the underpass you can go LEFT and leave the play volume
entirely."* Reproduced mechanically before anything was changed, with the new
`tools/containment.mjs` driving the shipped controller through the shipped
collision world: **27 of 144 scripted runs left the deck's -Z edge below the
top of the balustrade**, e.g. sliding in at 11 m/s and steering left put the
body through the rail at `x=133.63, y=0.34, z=-8.38` and off the edge at
`x=135.24, z=-9.57`, then into free fall.

- **`src/kit.js` — `balustrade()` now declares the baluster band's collider.**
  This is the root cause and it is a hard-rule-2 violation: the turned
  balusters are drawn with `L.mesh`, which is visual-only by construction, so
  every balustrade in the course had colliders under its plinth (0.34 m) and
  inside its top rail (1.28 m) and a **0.94 m collision hole in between**. A
  standing capsule is 1.75 m and is stopped by the rail, so nobody found it;
  the 0.95 m *sliding* capsule that the underpass's 1.35 m ceiling **forces**
  you into steps onto the plinth for free and passes straight through a barrier
  the player can see. Fixed with one `solid(..., { hidden: true })` slab per
  run, baluster-deep — at the widest pitch this kit emits the clear gap is
  0.66 m against a 0.68 m capsule, so the run was already impassable in
  fiction. `ghost` runs are unaffected.
- **`src/level.js` — the underpass's -Z balustrade starts at the island edge**
  (`x=123`, length 26) instead of at the lintel, so the whole left flank from
  the checkpoint through the slot is closed by architecture rather than by 8 m
  of bare edge. It still stops at `x=149`: the apron past it is where the
  `low-7` branch dashes in over the void, and a parapet there would delete an
  authored route.
- **`tools/containment.mjs`** — the probe, kept. `reachability.mjs` proves you
  can get everywhere the course intends; nothing proved you could not get
  *out*. Now **0 of 144 runs** cross the flank below the rail. Exits over the
  top of the rail and off the lintel roof are counted and deliberately allowed
  — the roof is play space, the climb verb goes up a 1.6 m parapet by design,
  and falls are recoverable.

No tuning constant was touched; the movement set is byte-identical.
`node tools/reachability.mjs` still PASSes with all 22 checkpoints chained
without dash or grapple, and `bash tools/ship-gate.sh` exits 0.

## 2026-07-25 — geometry unlock, vegetation, instrumentation, audio

Shipped as `78603ac`. Four parallel workstreams; the commit message named only
three of them, so recording the fourth here.

- **`src/props.js`** — real curved geometry. Lathed shafts and domes, radiating
  arch voussoirs, swept tubes, involute gear teeth, chamfered boxes, and a
  noise-displaced blob for rounded rock. Nothing has to be a stacked box now.
- **`src/foliage.js`** — instanced alpha-tested vegetation off a procedurally
  generated atlas, with vertex-shader wind. Vegetation is roughly 40% of the
  reference by screen area and the game previously had none.
- **`src/kit.js`** — rebuilt on both. Turned balusters, columns with real
  base/shaft/capital, ivy on every lip, moss in the junctions.
- **`src/hud.js` + `index.html`** — brass instrumentation, and wayfinding now
  exists: an edge chevron that orbits the frame perimeter and cannot enter the
  centre, a bearing rose, an altimeter tape, checkpoint pips, and ability lamps
  with real lit/unlit contrast. Needs `hud.setNav(camera, level)` from main.js.
- **`src/audio.js`** — surface-aware cues (the contact material was never
  published on the player, so audio reads the collision world itself), six
  mix buses with ducking, a procedurally generated stereo impulse response with
  frequency-dependent decay, a ray-probe driving reverb wet from 0.05 in open
  sky to ~0.4 in a corridor, and a clockwork layer that free-wheels when you
  leave the ground. Output is soft-clipped so clipping is structurally
  impossible.

Measured: 1.23M triangles at 52–65 draw calls, 4.3–11 ms/frame, all eight
harness shots rendering with no clipping low.

**Not verified:** how the audio actually sounds. It was checked structurally
against a mock Web Audio graph — node counts, gain ranges, voice budgets, IR
decay — but nobody has listened to it.

## 2026-07-25

- **Graphics push closed out at 52/100.** A baseline critique scored the game
  AMATEUR 24/100. Two adversarial rounds of specialist work against that
  critique brought the critics' average to 52/100 — competent, not good, and
  the remaining gap is written up as the "round three" list in
  `docs/roadmap.md` rather than being claimed as done.

  What landed and is visible in the shot set: the architecture kit is actually
  placed (15.6k → ~986k triangles at ~43 draw calls, 2.9–5.4 ms/frame), the
  surface material gained macro relief, two-band macro variation, world-planar
  projection and height-preserving de-tiling, and the render pipeline gained
  screen-space contact shadows, analytic sky IBL through PMREM, a procedural
  grade LUT and a warm aerial-perspective term. `tools/shotset.mjs` captures
  and measures 8 named gameplay poses in one launch, which is the only reason
  any of this could be judged.

  What did not land, honestly: there is still no cloud sea — the deck shader in
  `SKY_FRAG` assumes a deck one unit below the camera and produces a single
  screen-filling blob, so `vista.png` is a flat khaki gradient where the brief
  asks for "a sea of golden sunset clouds". Nothing in any frame is dark (0.00%
  clipped low on all eight shots, p1 between 38.8 and 57.4). The lit walking
  deck is mint-teal against peach risers, because the grade's shadow tint keys
  on display luminance rather than on the lighting term. Brass is one flat
  mustard value with no crevice darkening. Every island shares one silhouette
  and the undersides are countable cubes. `SURFACE.brass.glint` was pulled
  1.5 → 1.15 to stop the balustrades clipping; measurement says it did not move
  `underpass.png`'s 2.77% clipped-high at all, so that cause is still unfound.

- Movement: you can steer a jump now, and a double jump stops catapulting you.
  Air control was Quake `accelerate()` alone, which can only add speed along the
  wish direction and barely bends the arc at 20 m/s; steering is now a separate
  magnitude-preserving rotation at a speed-widening turn rate (75.8° in half a
  second at sprint). The air jump was assigning full current speed to the new
  direction, firing you sideways at 20 m/s; it now blends heading halfway
  (52.9°, magnitude preserved). The two mechanisms are kept separate so steering
  can never become a speed exploit — one second of hard alternating air input
  gains 0.15 m/s.

- Firebase Hosting target added — `npm run deploy` builds and ships to
  https://skyline-courier-5329.web.app, playable by anyone with the link.
  Hosting only, no Firebase SDK in the bundle; see `docs/deploy.md`. Source
  now also lives in the private repo `Calculator5329/skyline-courier`.
- Created the project. Vite 7 + Three.js r180, no other runtime dependencies.
  Successor to the parked `games/clockwork-garden`; carries over its fiction
  (the wind-up courier), palette, and taste rules, and drops the Unreal +
  generated-3D-asset pipeline that stalled it.
