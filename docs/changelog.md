# Changelog

## 2026-07-25 — the void gets its own rock, and themes get a surface half

Ethan, after playing the void: the rock "is nowhere close to the reference
image". It was not — `PALETTE.stone` and the `stone` painter were SHARED with
the sunset level, so the void's entire mass was the archipelago's cool
grey-green limestone under a violet light. `art-direction-void.md` §2's
value-structure table passed the whole time, which is exactly what §0 warns
about: those numbers only say the LIGHTING is right.

**The seam.** `theme.surfaces` gains two keys beside the `shade` multiplier
`voidkit.js` was already reading:

- `surfaces.kinds` — a per-theme alias map, resolved in `materials.js`
  `resolveKind` at the point a material is built. The void maps `stone` →
  `voidrock`, so every `L.solid(..., 'stone')` in the course comes out as void
  rock with no change in `voidkit.js`, `levels/void.js` or `kit.js`. Aliasing at
  material-build time rather than renaming kinds at the call site leaves
  batching, coverage and the draw-call budget bit-identical — the batch key is
  still the kind the caller named.
- `surfaces.macro` — the five environment-derived colours in
  `materials/shader.js` (`scCavityCol`, `scShadeCol`, `scSkyWarmCol`,
  `scHorizonCol`, `scPatinaCol`), five of `scaling-plan.md`'s 48 hardcoded
  colours and the five every lit texel passes through. Each is a claim about a
  golden-hour sky ("a pocket sees the cool green zenith") and each is false in a
  void. Defaults are the skyline's own values lifted verbatim, so a theme that
  names none of them renders exactly as before.

**Two new painters, structural rather than hue-rotated.** `scaling-plan.md` is
explicit that a structurally distinct theme needs the painters parameterised by
structure, and a violet limestone would have failed §8 on sight.

- **`voidrock`** — built on a new `fracture()` primitive: a tiling
  jittered-lattice Worley cell returning distance, cell-boundary proximity, a
  stable per-cell id and a per-facet tilt. Two octaves (0.60 m facets, 0.22 m
  chips) give flat facets at their own levels and their own tilts meeting along
  hard 1.4-2.5 cm creases. There is no dome in it anywhere, which is the whole
  point: `stone` is 46 domes and 26 crevices, the vocabulary of rock that has
  weathered, and this rock has not. Plus mineral veins on a third, unrelated
  fault system, and embedded blue/violet micro-crystal drawn as facets on all
  four channels.
- **`voidcarved`** — §4.1's machined cliff. A `PANEL_TABLE` in the spirit of
  `COURSE_TABLE`, but describing a different act of building: one 2.38 m panel
  per tile on an ALIGNED grid, square 1.2 cm shoulders against ashlar's 3-4 cm
  chamfers, an incised inner border, machined index ticks at a regular pitch,
  and violet mote dust in the grooves driven by the cavity of the height field.
  Two corrections got it there, both recorded in the source: 0.8-1.2 m panels
  rendered as brick, and so did 2.38 x 1.3 m panels, because the `offset` column
  was staggering the rows into a running bond. Size was never the tell; the bond
  was.

**Calibration, and the thing most likely to be "fixed" back.** §3's `#14101F` to
`#2A2438` is a colour read off the reference IMAGE, so it is a rendered pixel,
not a reflectance. Painted as an albedo it is invisible — measured at rgb(1.0,
0.9, 7.1) on `ascent.png`, i.e. black, because the void's key runs at an eighth
of the skyline's with no sun behind it. `PALETTE.voidrock` is `0x564c68`, the
reflectance that RENDERS to §3: a shaded face lands at rgb(25.4, 8.3, 47.2),
hue 266.4 against §3's 268. Brass makes the same argument for the same reason.

**Not fixed, and not in this lane** (both now in `docs/roadmap.md`): the lit
faces are still tan, and it is not the surface. `scHazeSun` in
`render/patch.js` is `0xfff0d2 * 1.5` and is added to everything as a Fresnel
rim at the void's doubled `aerial.rim` of 0.32. With the rim off the same face
renders at rgb(1.0, 0.9, 7.1) — the rim is supplying essentially all of the
light on the void's mass, and supplying it warm.

`skyline` is unchanged. `closeup` measures lum 111.1 / sat 0.807 / p1-p50-p99
21.5-116.8-187.9 against a pre-change baseline of 111.1 / 0.807 /
21.6-116.8-187.9, and `tools/ship-gate.sh` is green.

## 2026-07-25 — crystal shards: the void theme's light, as geometry

`docs/art-direction-void.md` §4.3 asks for two families of jagged faceted
crystal, and §7.3 makes instancing and LOD requirements rather than
optimisations. Three pieces, all new, none of them touching the level:

- **`src/props.js` — `shard()` and `shardCluster()`.** An n-gonal frustum stack
  with a bent axis and an off-centre apex, every face emitted with its own
  vertices and its own plane normal, so there is a hard normal break on every
  edge by construction. `lathe` was rejected because it revolves one radius per
  profile point and therefore cannot be asymmetric or bent; `chamferHex` was
  the right idea but caps the facet count at four and chamfers exactly the
  arris a crystal needs to keep sharp. The comment in `props.js` carries the
  full argument, including the planarity proof that lets a facet be flat-shaded
  from three of its four corners.
- **`src/crystals.js` — `crystalMaterial()` and `CrystalField`.** One
  `InstancedMesh` per (family, detail band, variant): a measured **300 clusters
  in 12 draw calls**. Colour is a parameter everywhere and there is not one
  colour literal in the file (§7.2).
- **`tools/crystal-shot.mjs` + `tools/crystal-preview.html`** — a scratch shot
  harness, because the crystals are not in the course yet and `shotset.mjs`
  photographs the course. It uses the real `RenderPipeline` and the real void
  theme, so the frames are comparable with §2's acceptance table.

Two findings that only a render could have produced, both now fixed and
documented where they were made:

- **Flat normals are not enough on an emissive object.** Emissive has no normal
  term, so a shard lit mostly by its own glow shades identically on every facet
  however hard the break is. The first render came back a smooth pale monolith.
  `facetVariance` bakes a seeded brightness step per facet column into the
  colour attribute, which puts the value break back on the arris.
- **The vertex-colour ramp was pushing albedo over 1.** `vColor` multiplies the
  diffuse term as well as the emissive one, so a 1.7 tip meant a surface
  reflecting more light than reached it; every shard came back a clipped white
  spike. The ramp now tops out at 0.78 and brightness above white is the
  emissive's job, where the bloom threshold can see it.

Triangle counts per LOD, from `node src/crystals.js`: a single hero shard is
24 / 36 / 48 triangles at FAR / MID / NEAR; a hero cluster averages 110 / 164 /
219 and a scatter cluster 119 / 178 / 237. Silhouettes are identical across
bands to 2 cm — only the ring-station count moves, deliberately, so a cluster
never pops when it changes band.

Not yet placed: nothing imports `crystals.js`, so the bundle is unchanged.
Wiring it into the void course belongs to the level lane.

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
