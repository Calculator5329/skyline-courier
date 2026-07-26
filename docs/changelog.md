# Changelog

## 2026-07-26 — the backdrop stops being pale flat origami

A harsh review of the rendered frames, on the band above the deck in
`summit.png` and the upper-left quadrant of `plunge.png`:

> "large pale-lavender flat-shaded polygons with no internal structure, no
> windows, no fracture, no edge glow — literally paper triangles... A ratio
> above 1.0 is a fog bank with lumps in it, which is exactly failure mode §8.3."

This is Ethan's "less depth and detail in the backdrop" complaint, second time
of asking, and the cause was structural rather than a tuning miss. All of it is
in `src/fx/voidbackdrop.js`.

- **The value ladder was inverted, and is now the right way up.** The three
  bands were authored at 0.95 / 1.50 / 1.85 of the dome's value — the far band
  deliberately LIGHTER than the sky, on the reasoning that a distant mass is
  mostly the lit haze in front of it. True in a daylit valley, false in a void
  whose haze is lit from below and behind: the reference shows dark spires
  standing in front of a glowing violet volume. Now 0.55 / 0.66 / 0.78 —
  contrast still falls with distance, it just never crosses over.
- **The body brightness was the real culprit and it took three passes to find.**
  At these ranges the mass is ~30% of the pixel and the inscatter ~70%, so
  winding the inscatter gain down did almost nothing while `uHazeParams.w` was
  high. Body is now 0.035-0.05, and the surface detail multiplies the
  COMPOSITE through a `shade` term that only ever darkens — so a groove can
  never come out lighter than the haze it sits in.
- **Four silhouette archetypes replace one cone.** `towerCluster` (gothic
  towers with needles), `hangingRuin` (a plateau over a fractured plinth with
  five to eight drips of different lengths), `slabStack` (setback ziggurat with
  masts) and `shardCluster` (the drifting fragments). Each is a CLUSTER of
  6-14 tapered prisms, so one instance reads as a district. Every archetype is
  authored inside a unit cell and `assertBounds()` throws if one escapes it,
  because `clearanceOf()` bounds instances by that cell.
- **Internal structure, as a shader rather than a texture:** storey grooves and
  panel breaks on near-vertical faces, a per-face value break, a narrow edge
  glow, sparse emissive fracture seams, and a world-space glint grid — violet
  with a rare red, one cell in ~35. That last one closes the roadmap item "the
  far bands carry no light of their own". Every feature is sized in METRES and
  sized above the pixel it lands on (9-15 m grooves, 6-10 m glint cells);
  finer than that is not detail, it is noise that crawls.
- **Cost.** 3 draw calls and 29k triangles → 10 draw calls and 176k, against a
  scene that is already 2.9 M. Measured `ms/f` across the void shot set is
  3.5-5.2 against a 3.5-5.5 baseline: no change outside run-to-run noise. The
  old budget was a false economy — one percent of the frame's triangles for
  half of the frame's area, spent on one cone repeated a thousand times.

Measured, void shot set, before → after: `summit` lum 54.5 → 47.5 with spread
55.6 → 64.8; `plunge` 51.5 → 41.1; `midclimb` 46.5 → 34.0; `ascent` 28.9 →
25.6. `ascent` now sits 2.4 under §2's `lum` floor of 28, and the honest
reading of that is unwelcome: rendering with the backdrop disabled entirely
measures 27.3, so the old frame only cleared the floor BECAUSE the backdrop
was paler than the sky it covered. The metric was being met by the defect.
Skyline is untouched — `closeup` still measures lum 111.1, sat 0.807.

## 2026-07-25 — the void gets dense

Ethan, with the build beside the reference image:

> "we are significantly less detailed and have less cool unique additions
> compared to the reference image and we have less depth and detail in the
> backdrop as well and less overall objects we have."

Correct. The void had four prefab types (great wall, rune slab, sigil ring,
monolith) spread over a 508 m shaft, and the `plunge` capture — the shot
looking straight down the whole climb — was four dark squares on a flat violet
field. The reference frame has, on top of everything we already had: broken
arcades, hanging chains, thin spires, carved statuary, stepped ziggurat masses,
small floating debris at every depth, glowing orbs receding into the haze,
hanging banners, cracked causeways between masses, and ruin districts stacked
layer on layer into the fog.

- **Nine new prefabs in `src/voidkit.js`** — `brokenArch`, `ruinSpire`,
  `ziggurat`, `hangingChain`, `causeway`, `statue`, `banner`, `debrisCloud`,
  `voidOrb` — exported as `VOID_DRESSING`, deliberately separate from
  `VOID_PREFABS` so `trackedVoidKit().assertAllPlaced()` stays an invariant
  about the four load-bearing prefabs rather than a checklist.

- **`brokenArch` is a PIERCED WALL, not a ring of voussoirs**, and the reason
  is the collision contract. `level.js`'s `rot` channel shrinks a rotated box
  until it fits back inside its declared AABB, so a voussoir at 45 degrees
  touches the top of its own collider along one edge and leaves the rest of
  that face standable with nothing drawn on it — several square metres per
  arch, times every arch in the level. Sampling the wall in vertical slices,
  each running from its own floor (the ground, or the elliptical intrados where
  it crosses an opening) to its own ragged crest, has no rotated boxes in it at
  all, and every slice's top face IS its own drawn surface at every angle.

- **`levels/void.js` places it in four bands.** Islands get chains off the rim,
  a satellite ruin hung below, and orbs behind their edges; the great walls —
  40 m of cornice 32 m over the route, previously carrying nothing but a sigil
  — get an arcade on top, spires at both ends, statuary on the parapet, banners
  down the inward face and chains off the outward one; the interior of the
  spiral gets ruins hung 24-60 m under the flight line; and four concentric
  rings out to r = 545 carry ziggurat districts joined by broken causeways.

- **Ghost or solid is decided by measurement, never by eye.** Beyond 78 m from
  every island a piece is drawn with no collider and registered with
  `Archipelago.sceneryAt`, so `verify()` re-runs the arithmetic and proves the
  70 m clearance (it reports 79.5 m). Nearer than that it is fully solid. In
  between there is nothing, and in particular there is no "it is only decor".

- **The keep-out is a VOLUME, not a radius**, and it took a failure to learn.
  The first cut gated solid dressing on 3D distance to the nearest island and
  shipped a checkpoint inside a ruin — `assertTriggersClear`: "ascent 2: buried
  in stone (top 128.53, deck 120.86)". A scalar cannot say that a statue 18 m
  away and 14 m BELOW a landing is fine while an arcade 18 m away at the
  landing's own height is a wall across it. It is now a cylinder 5.5 m proud of
  every island rim, from 4 m under the deck to 9 m over it, and every call site
  states the prefab's real vertical span.

- **Three separate coverage bugs found and fixed by `tools/coverage.mjs
  --page ?theme=void`**, which took the void from 0.50 m2 of standable-but-
  undrawn surface to 152 m2 before they were: a blob is drawn inside its
  bounding BOX and can never cover that box's four top corners — 21% of the
  face, at any squash — so statue heads, chain counterweights, debris chips and
  monolith fragments are all chamfered cuboids now; and a sagging chain
  declaring one AABB per span left a 0.8 m box with a 10 cm tube through it,
  fixed by cutting the free-hang drift to 5% of the length so each span's box
  is under the 0.5 m sampling cell. Back to 9.00 m2 over 12,388 colliders.

- **`runeSlab` gained broken corner posts**, on the diagonal only (the corners
  of a square sit at 1.41 half-widths, well outside the 82% landing margin) and
  capped under the 1.45 m mantle, so the worst case is a vault and never a
  block. They draw from a DEDICATED RNG stream: the first cut inserted four
  `rand()` calls into the middle of the existing sequence and re-rolled every
  underside in the level, which is what moved a tier stack into the headroom of
  the island below it.

- **Cost, measured back to back on the same machine:** draws 83 → 99 (ascent),
  107 → 125 (plunge); triangles 1.70 M → 2.93 M; frame time +5% to +41%
  depending on shot. Draw calls barely move because `level.js` merges every box
  and every `L.mesh()` of one kind into a single geometry, so density costs
  vertex throughput rather than submissions, and the glow channel instances the
  orbs by quantised radius (six hundred orbs, seven draws). `bash
  tools/ship-gate.sh` exits 0, `node tools/reachability.mjs` passes, and the
  §2 value numbers stay in band.


## 2026-07-25 — the stone is lit from inside

Ethan, with the build beside the reference image: the rock is the right
near-black violet and the lighting is fixed, but the reference has **glowing
veins and cracks running through the rock** — thin magenta and violet fissures
threading the dark masses, brightest deep in the crack and fading at the lips —
and the build had none. They are everywhere in the reference, through the great
walls and the floating masses alike, and they are a large part of why that
image reads as magical rather than merely dark.

- **`paintGlowVeins` (`src/materials/textures.js`) — where the fissures are.**
  Its own fault lattice at ~0.8 m, seeded independently of the rock's two
  `fracture()` octaves, so the veins CUT ACROSS the facet structure instead of
  outlining it. One distance field is written into four channels at three
  widths: a 1.4 cm incandescent core, a halo three times wider at a tenth the
  brightness (purely so the signal survives the mip chain), and a lip four
  times wider again that carries no light at all — it is a real cut in the
  height field, so the normal map gives it relief and `SC_CAVITY` darkens and
  violet-tints it. Dark rock hard against a bright core is the whole effect.
  Albedo goes DOWN beside a vein and never up: light from inside means the
  visible rock darkens and only the emissive channel carries the brightness.

  **The structural finding, after three wrong versions.** Which cracks are lit
  cannot be decided by a noise field, because that is a decision per texel. A
  coarse field lights whole cell rings and the wall reads as crazing; a fine one
  perforates every line into dashes and then into specks, and the wall reads as
  glitter. Selection has to happen on the TOPOLOGY: `faultEdges` names both
  cells at a boundary and `edgeKept` hashes the unordered pair, so a kept edge
  is lit end to end and its neighbours chain onto it. `keep` is pinned at 0.46,
  just under the lattice's bond-percolation threshold — high enough that edges
  chain into long wandering paths, low enough that the paths do not close into
  rings. A long path that does not close is a crack; a closed ring is a cell.

- **`SC_VEIN` (`src/materials/shader.js`) — how it lights.** The mask rides in
  the ORM canvas's RED channel, spare since that file was written, so it costs
  no texture memory, no sampler and **no extra fetch** — the roughness chunk
  was already sampling that map and now takes two channels off one read. It is
  ADDED to `totalEmissiveRadiance`, which is the one term that skips the light
  loop: a fissure with a fire in it does not dim on a rock's shaded side, and
  is not occluded by the cavity signal darkening its own lips. It lands before
  `render/patch.js`'s aerial perspective, so a vein twenty metres back washes
  toward the fog with everything else and joins §5's three depth bands.

  Coverage and hue are read off the macro field at ~12 m, not out of the tile.
  A 2.4 m tiling texture answers a question about a PLACE by repeating the
  answer several times per wall, which reads as a pattern — so "which rock is
  cracked" and "which cracks burn red" are world-scale. That is also what keeps
  §3's "red must stay rare" true: red is a handful of stretches of fault in a
  level rather than a fixed share of every square metre.

- **`theme.surfaces.veins` (`src/theme.js`) — whether, and how hard.** Off
  unless a theme names it: with `vein` absent no define is set, no uniform is
  allocated and no GLSL is emitted, so the skyline's programs are unchanged.
  How brightly rock burns from inside is a statement about a world, like the
  fog colour two blocks up, not a property of a rock.

  Measured: **the void gains the channel at zero cost** — 73/71/71/59 draws and
  961 705/961 305/961 345/958 905 triangles on `ascent`/`midclimb`/`plunge`/
  `summit`, identical to before, with `ms/f` inside run-to-run noise. §2's
  numbers move slightly the right way and none regress (`ascent` lum
  34.5 → 35.7, p99 207.6 → 208.2, `summit` p99 66.8 → 68.4). **The skyline does
  not move**: `closeup` holds at lum 111.1, sat 0.807, p1/p50/p99
  21.6/116.8/187.9 exactly, and the ±1 drift on other shots reproduces on an
  unmodified build.

  Deliberately NOT done: the fissures do not pulse (needs a time uniform from
  the frame loop, which is not this lane) and they do not light anything but
  themselves (a real bounce is a lighting-budget decision under §7.3). Both are
  on the roadmap.
## 2026-07-25 — the void gets its own ears

Ethan, playing the void: **"Audio feels wrong in the void."** He is right, and
the reason is structural rather than a mix problem. Every sound in this game was
authored for a warm, sunlit archipelago — a wind bed, brass-flavoured impacts,
footsteps on porous sandstone and turf, a small dry room modelled on the
underpass bay. Play that over a silent near-black cavern of floating ruins and
it is not a level with bad audio, it is the wrong game's audio.

So the audio half of a theme is now DATA, exactly like the light half:
`AUDIO_DEFAULTS` in `src/audio.js` holds the shipped skyline verbatim,
`VOID_AUDIO` in the new `src/audio/void.js` is the overlay, and a theme states
only what it changes. **The skyline renders bit-for-bit identically** — see the
receipt at the bottom of this entry.

- **The footsteps were the biggest thing wrong, and not for the reason it
  looked like.** `theme.js` names `voidrock` and `voidcarved` in its
  `surfaces.kinds` block, so it was natural to assume the audio just lacked
  profiles for them. It lacked something worse: `Level.solid()` tags a collider
  with the CALLER's kind, and `voidkit.js` emits every ruin as `'stone'`, so
  those two names never reached `src/audio.js` at all and never would have.
  `_profileFor` now resolves a tag through the theme's own alias map first —
  the same table `materials.js` resolves its painters through, which is what
  makes the material you hear provably the material you see. Then the two
  profiles: void rock is dead, dark and gritty (texture band at 780 Hz against
  sandstone's 1250, the lowest body in the table, no ring at all, the most
  debris); void carved stone is a dressed face with a quasi-harmonic ring
  (1 : 2 : 3.01 : 5.02, a struck glass rod) instead of brass's circular-plate
  series. Measured: a void footstep's spectral centroid is **910 Hz against the
  archipelago's 1565**.
- **The room is a shaft, not a bay.** `makeImpulseResponse` now takes its
  shoebox from the theme. The skyline keeps the 9 x 5.5 x 15 m underpass;
  the void gets 44 x 120 x 44 m of unweathered rock at 0.88 reflection. The
  number that does the work is the HEIGHT — at 5.5 m the first ceiling
  reflection lands 30 ms after the direct sound, at 120 m it lands 700 ms after
  it, and early-reflection pattern is what the ear sizes a space with. Measured
  RT60 (Schroeder T20, off the convolver's own buffer): **4.11 s against 1.52**.
  The wet floor goes 0.05 -> 0.30, because in the void "nothing around you"
  means the middle of a cavern rather than outdoors.
- **A sub-bass drone replaces the wind bed.** Wind is weather and weather needs
  sky; a cavern has air pressure. 24.5 Hz with a stack of fifths and octaves
  over it (no third, so it cannot fight the music), lowpassed, with breath
  noise under it and two mutually-prime LFOs on the cutoff so it never settles
  into a period. **99.9% of its energy is below 300 Hz, 92.8% below 80.** The
  archipelago's wind is not deleted, only cut to a tenth and moved an octave
  down: falling 100 m past a rock face still moves air, and that rush is the
  only continuous cue that scales with speed.
- **Height is audible, because the course climbs 500 m through the shaft.** The
  drone is loudest and darkest at the floor and thins as you climb; a narrow
  6 kHz shimmer, gated by `pow(height, 1.8)` so it is genuinely absent in the
  lower half, opens as you rise. The two cross over mid-course, so the spectral
  TILT of the bed is the altimeter. Floor to ceiling: **rms 0.026 -> 0.016,
  centroid 490 Hz -> 4708**. A fast fall swells the bed 60%, because a
  bottomless drop is the one thing this level can kill you with.

  The two ends of that ramp are a THEME number and not a module constant,
  which they had to become the moment the course grew from 22 islands to 40 in
  the same session: a ramp calibrated to 250 m of climb pins the shimmer at
  full and the drone at its thinnest for the whole upper half of a 500 m one,
  which is to say the altimeter stops working exactly where reading height gets
  hard. They are quoted off `levels/void.js` rather than guessed.
- **The energy beams hum.** `fx/voidfx.js` calls them level design —
  "unmissable vertical landmarks in a course whose whole problem is that the
  player must read height" — but only while they are in frame. Two sawtooths
  1.6 Hz apart (one is a test tone; two beat) with a band-passed corona over
  them, placed at `voidBeamSites()` rather than at a second set of coordinates
  that could drift. Distance is measured to the column's axis, not to a point.
  Beside one vs 900 m from every one: **3.78x in the 80-300 Hz band**.
- **The rune answers a boot.** `levels/void.js` puts a glowing inlay on every
  landing and calls it "the ONLY such channel a near-black level has" for
  saying you may stand here — which fails exactly when the player is not
  looking at their feet, i.e. during every 30 m grapple crossing. A landing now
  rings the inlay: quiet, high, cycled through three notes so 22 of them are
  not a jingle, on the UI bus beside the checkpoint bell. A void landing
  carries **6.9% of its energy above 2 kHz against the archipelago's 1.5%**.
  The bells themselves went crystal too — same quasi-harmonic ratios, up a
  fifth. There is no brass in this world.
- **`tools/voidaudio.mjs` (new) — the receipt.** Audio has no visible output,
  which is exactly why it is easy to get wrong and believe otherwise:
  `Audio.update` swallows its own exceptions by design, so no console error is
  evidence of nothing, and a node-graph inspection cannot tell a connected node
  from an audible one. So this RENDERS. `Audio.init` takes an optional context,
  the probe hands it an `OfflineAudioContext`, drives the shipped engine into
  named game states with the real player in the real collision world, and
  measures the samples: RMS, peak, spectral centroid, four band energies, and
  RT60 by Schroeder backward integration. **19 assertions**, every one a number
  that came out of a renderer.

  It earned its keep immediately. The drone's summing node shipped its first
  version at a gain of 0.0001 — copy-pasted from the output stage — which is a
  bed 80 dB down: inaudible, and invisible to every check except a render.
  Then, once it was audible, the probe caught the drone peaking at 0.21, above
  the -18 dBFS safety compressor in `audio.js`, which would have turned a
  device that is meant to see signal only when cues stack into a permanently
  engaged one. Both are now guarded assertions.

- **SKYLINE DID NOT REGRESS, and this is the measurement rather than the
  claim.** A detached worktree at `07d5a47` with two lines added to `init()`,
  built and rendered against the same seven-cue skyline sequence:

  | cue | rms before | rms after | Δ |
  |---|---|---|---|
  | step | 0.00094796 | 0.00094796 | 0 |
  | land | 0.01840182 | 0.01840182 | 0 |
  | walljump | 0.00431326 | 0.00431326 | 0 |
  | checkpoint | 0.01260696 | 0.01260696 | 0 |
  | finish | 0.03545635 | 0.03545635 | 0 |
  | sequence | 0.01643755 | 0.01643755 | 0 |
  | wind at speed | 0.06898946 | 0.06898946 | 0 |

  Peak agrees to 7 decimal places; the residual (<= 9e-8) is at or below the
  run-to-run floor, established by rendering the SAME tree twice and getting
  differences of the same magnitude — Chromium's convolver and compressor are
  not bit-reproducible. Getting to zero took one real correction: deriving the
  reverb's two INITIAL param values from the config instead of leaving them as
  the shipped literals moved every skyline render by 0.2%, because
  `setTargetAtTime` starts from wherever the param is and a different starting
  point is a different trajectory. Inaudible, and not worth being unable to say
  the number is zero.

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
