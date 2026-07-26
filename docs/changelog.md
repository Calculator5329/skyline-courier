# Changelog

## 2026-07-25 — the void gets a background, and its beams get cut to six

Two notes from Ethan with the build beside the reference image, answered
together because they are the same complaint from two sides: the void was a
course floating in front of flat violet fog, and the only thing in that fog was
a dozen interchangeable red lines.

- **`src/fx/voidbackdrop.js` (new) — the far bands.** `art-direction-void.md`
  §5: "depth in three bands... if everything sits in one band the space
  collapses." The void had one. This adds three: silhouetted ruin masses,
  spires and drifting fragments in clustered districts at 360-470 m, 600-760 m
  and 820-960 m, spanning y -820 to +580 so the depth keeps going below the
  course as well as above it.

  The mechanism is one number per band, and it took four measured attempts to
  find: **the near band renders DARKER than the dome behind it (0.74x), the mid
  band at the dome's own value (1.05x) and the far band LIGHTER (1.26x)**.
  Every earlier version made the whole layer lighter at every range, which is a
  fog bank with notches cut in it, not three bands. That needs a different
  extinction curve per band, which is why there is a material per band rather
  than one shared one.

  Cost, measured on the void shot set: **3 draw calls, 360 instances,
  11 728 triangles** — 35 draws and 23 393 tris total against 32 and 11 677
  before. One archetype (a tapered n-gon prism with a broken point under it)
  scaled into masses, spires and fragments; LOD is by band and decided at build
  time, since a thing that can never be approached can never need a closer
  mesh. Colours all come from the theme descriptor and the haze fades into
  `scVoidGradient`, the same evaluation the dome and the aerial perspective
  use.

  **It is unreachable, and that is measured, not asserted.** No instance ever
  enters the collision world, and `assertClear()` throws if any of them comes
  within 140 m of the play volume — double the 70 m `Archipelago.verify()`
  demands of the sunset level's ghost islands. Measured clearance: **174.2 m**.
  The check found a real fault on its first run (a bounding-sphere
  approximation reported 56 m for spires whose real approach was over 190),
  which is the point of having it.

- **`src/fx/voidfx.js` — twelve beams became six.** Ethan: "roughly a dozen in
  frame, all similar, all pin-sharp, and several rake diagonally so they
  converge like searchlights." The beams were geometrically plumb the whole
  time; what was wrong is that they were laid out along +X across 250 m of a
  course that no longer exists — the void runs +Y up a shaft around the origin
  — so they stood in empty space and were only ever seen end-on and far away,
  where perspective turns a row of parallel verticals into converging
  searchlights.

  They are now a hand-written table of six, not a loop over a PRNG. Four stand
  on the radial line through the islands the side paths branch from, pushed
  13 m past the great wall beyond each one so the wall silhouettes against them
  (§5, "silhouette against glow"); two are far out in the backdrop's near band
  so the middle distance has a vertical in it. Every site names its own length,
  base height, radius, intensity and haze multiplier, and no two are close: the
  brightest is 3x the dimmest, the thickest 1.6x the thinnest, one deliberately
  ends below the top of the course so you climb past it, and one starts above
  the plaza so it hangs with nothing under it.

- **`src/world.js`** builds the backdrop beside the sky and the fog (it is
  behind the world in the same sense they are), and the beam-clustered motes
  now take their column from the site's own `y` and `height` instead of a
  fixed -12..98 m window sized for a course that topped out at y 88 — the upper
  two thirds of every beam had no dust on it.

Void shot set, before -> after: `ascent` dyn 161.5 -> 181.4, `summit` dyn
59.3 -> 78.0, `plunge` spread 37.6 -> 49.6. All four still inside §2's `lum`
28-55 and `p50` 22-45. `bash tools/ship-gate.sh` exits 0 and the skyline set is
unchanged to the last measured digit (`closeup` 111.1 / 0.807 /
21.5,116.8,187.9, 59 draws, 2 211 509 tris — identical to the untouched tree).

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
