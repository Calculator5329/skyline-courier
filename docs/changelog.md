# Changelog

## 2026-07-27 — the frame audit measured, and the quality menu is a placebo

Ethan played the deployed build: *"graphics lite doesn't change anything, and
FPS still seems bad. should easily run 240fps."* Both complaints are one bug
with two layers, and the audit lane's own gate was mis-calibrated on top.

**Layer 1 (fixed earlier today): the Settings quality control was half-wired.**
It called `applyPixelRatio()` and `pipeline.setQuality()` but never
`renderer.setSize()`, and three only rebuilds the backing store on `setSize`.
The seg now stages into the settings edit buffer and Apply commits through the
one real `setQuality`.

**Layer 2 (open): every quality level is the same level.** `QUALITY_LEVELS` in
`src/render/quality.js` differs across `high`/`balanced`/`lite` in exactly one
field, `pixelRatioCap` (2 / 1.5 / 1). `contactShadows`, `contactScale`,
`contactSteps` (14), `aoTaps` (8) and `aoNearTaps` (5) are **identical in all
three**. So on any display reporting `devicePixelRatio` 1, Lite is byte-for-byte
High and costs exactly the same. Measured, 1600x900 headless, mean of terrace /
crossing / tower / closeup:

| level | mean ms/f | fps |
| --- | ---: | ---: |
| high | 2.88 | 348 |
| balanced | 3.19 | 313 |
| lite | 3.22 | 311 |

Lite is not faster. It is marginally slower, which is the noise floor. The file
comment says the knobs that belong here are "pixels, and the contact-shadow
pass that consumes them" — the contact fields exist per level and nobody ever
gave them different values. That is the gap between a plumbed setting and a
setting.

**The audit's CPU work is real, and it was not the bottleneck.** Mean across 20
shots, both arms captured in one harness run:

| metric | before | after | delta |
| --- | ---: | ---: | --- |
| CPU ms/f | 0.376 | 0.341 | **9% less CPU per frame** |
| GPU-synced ms/f | 2.091 | 2.111 | unchanged (within noise) |

The one-time scene discovery, static-level matrix freeze, partial emitter
selection and dropped duplicate sun-target update all do what they claim. The
frame is GPU-bound, so removing CPU work does not move the wall clock. That
closes the previous entry's missing after-numbers with measurements rather than
a pointer to the tool.

**The gate cried wolf, and the wolf was the gate.** `tools/perfbaseline.mjs`
reported FAIL on terrace / tower / zenith across two runs, which looks like an
image change. It is not. Two `shotset` captures at **identical code** vary by
up to **0.7 luma on terrace's p99** — more than three times the 0.2 tolerance
the gate asserts. The tolerance claims a precision the capture does not have,
so it manufactures failures on exactly the high-contrast shots whose p99 is
decided by a handful of pixels. Verified by bisect: reverting the sun-target
change alone, and the matrix-freeze alone, each left the same three shots
failing. A gate that fires on noise trains people to ignore it, which is the
same defect class as a gate that never fires.

**What 240 Hz actually needs, stated honestly.** At 2560x1440 native the
shipped frame is 4.8-6.5 ms on the heavy shots (240 Hz needs 4.16) and the
diagnostic no-contact floor is 2.9-3.2 ms. So the contact pass is roughly 40%
of the frame and turning it down is the only lever with enough room in it. That
is a quality-menu decision, not a free optimisation — which is precisely what
the quality menu was supposed to offer and does not.

## 2026-07-27 — frame work that did not draw a different pixel is gone

The real-frame audit found four CPU costs that were unrelated to the rendered
image: periodic whole-scene discovery after the scene was already complete,
automatic matrix work on the static level in both scene passes, a full sort of
up to 96 void emitters to use 16, and an explicit sun-target matrix update
immediately before the renderer repeated it. They are now one-time,
event-driven, partial-selection, or single-update work respectively.

The full-resolution contact pass also sampled linear depth at a candidate
pixel, then sampled the normal buffer solely to ask whether that same pixel had
geometry. `GBuffer` clears both attachments together and every covered prepass
fragment writes positive view depth and coverage `1`, so the shipped shader
uses the depth it already fetched. This removes up to 27 dependent reads per
shaded pixel without changing any ray, threshold, sample count, or expression.

`tools/perfbaseline.mjs` restores all five old paths as one executable
before-arm. It captures the complete skyline and void baseline first, then the
shipped arm, reports CPU and GPU-synced ms/f, and fails if luminance or any
p1/p50/p99 moves by more than **0.2 luma units**.

### Measured frame budget, native 2560x1440

These are the existing interleaved measurements that motivated and bound this
work. The diagnostic no-contact arm is included to show the fill floor; it is
not shipped because it changes the image.

| skyline shot | before ms/f | 240 Hz headroom | no-contact floor |
| --- | ---: | ---: | ---: |
| terrace | 4.80 | −0.63 | 2.90 |
| crossing | 5.52 | −1.35 | 3.11 |
| tower | 5.04 | −0.87 | 2.57 |
| vista | 2.53 | +1.64 | 2.06 |
| closeup | 6.47 | −2.30 | 3.18 |

The previous 07-27 entry omitted its before/after table. This lane's sandbox
still rejects Chromium startup (`sandbox_host_linux EPERM`), including
single-process/no-zygote mode, so recording an after number here would be
fabrication. The fail-capable command that must close that final evidence gap
outside this sandbox is `node tools/perfbaseline.mjs`; the physical-display
1080p/1440p run is `node tools/perfbaseline.mjs --live --headed`. Until that
run supplies actual after values, the measured claim is deliberately limited
to the before/floor table above and the code changes themselves.

## 2026-07-26 — the far distance is a painting now, and the impostors are gone

Ethan, on the baked-impostor build shipped earlier the same day:

> "honestly the random shapes in the background is very weak hoping the image
> method will improve it."

He is right, and the reason is structural rather than a matter of tuning. Every
silhouette in that layer came from one function — `ruinGeometry()`, a tapered
n-gon prism with a broken point. Bake ten into a tile and the tile is an
angular blob; draw seven hundred tiles and the frame has seven hundred angular
blobs in it. Density was the only dial the layer had, and density for its own
sake is exactly what he called weak.

**`public/sky/void-dome.png` is now the void's sky dome** — one painted
panorama with real gothic architecture in it (arches, tracery, buttressed
spires), tiled 4x around the horizon. It is the second exception to CLAUDE.md
rule 1, approved by Ethan on the same day, and it is the only image file the
game loads for this theme.

**It composes WITH `render/skygrad.js`, it does not bypass it.** The dome does
not introduce a colour. `scDomeSky()` in `src/world.js` picks, per direction, a
point on the line between two values `scVoidGradient` already produces: the
local gradient value scaled down (`lo`, the silhouettes) and the haze anchor
scaled down (`hi`, the open void between them). So the background's colour and
its whole vertical ramp are still the one evaluation the aerial perspective and
`scene.fog` read, and the painting supplies only the high-frequency half — the
same division of labour the skyline's cloud deck has with the same gradient.

**The value inversion is unreachable by arithmetic, not by care.** `hi` is
0.95, strictly under 1, so the brightest pixel the dome can produce is dimmer
than the brightest pixel the background could already produce before the image
existed. The failure a previous session shipped — background brighter than the
mass, every rock a black cutout — cannot be reintroduced from this file
whatever is painted into the PNG. Lit rock in these frames sits at p99 194-218;
the dome's ceiling renders under 90.

**No horizon line.** The band runs pole to pole with a 9 degree taper at each
end, so there is no elevation at which the modulation's derivative spikes. Two
earlier attempts got this wrong and both were caught by looking: a 22 degree
fade against a 120 degree band printed a visible arc across the upper right of
`midclimb`.

**And the far impostor band is deleted** — the whole atlas bake, the card
shader, the elevation slices, ~650 lines. Measured side by side at `summit` and
`plunge` with the dome wired in, the cards did not add to the painting, they
drew a bed of pale faceted gravel ACROSS it and hid it. What goes with them,
stated honestly: one draw call, ~1 440 triangles, ~42 ms of boot-time bake, a
16 MB render target — and real parallax at 780-1010 m, which is the genuine
loss. The near band (470-600 m) and the mid band (690-850 m) are still real
geometry and still parallax correctly; the judgement is that two bands of
moving silhouette plus a painting that is actually architecture beats three
bands where the third is moving gravel.

### Measured, void shot set, 1600x900, 90 pumped frames

| shot | lum | p1/p50/p99 | clip hi/lo | draws | tris | ms/f |
| --- | --- | --- | --- | --- | --- | --- |
| ascent | 37.2 -> **38.7** | 1.7/19.3/194 -> **1.4/22.0/194** | 0.31/0.01% -> **0.30/2.18%** | 95 -> **94** | 2 936 311 -> **2 934 335** | 10.6 -> **11.9-12.2** |
| midclimb | 31.0 -> **33.3** | 1.9/20.9/194 -> **2.3/17.7/200** | 0.27/0% -> **0.30/0.41%** | 85 -> **84** | 2 934 311 -> **2 932 335** | 6.7 -> **7.5** |
| plunge | 32.9 -> **29.1** | 5.3/27.4/152 -> **5.0/19.7/158** | 0.26/0% -> **0.28/0%** | 119 -> **118** | 2 941 151 -> **2 939 175** | 6.5 -> **7.7-8.4** |
| summit | 60.6 -> **61.3** | 5.9/34.3/218 -> **3.9/35.4/218** | 3.17/0% -> **3.17/0.01%** | 93 -> **92** | 2 935 911 -> **2 933 935** | 9.1 -> **9.5-9.6** |

**The dome itself is free.** A/B with `dome.amount` at 0 against 1, same build,
same session: `ascent` 12.03 ms against 11.86-12.15, `summit` 9.49 against
9.48-9.62. One texture fetch on a sphere that was already being drawn does not
show up. The ms/f column above is therefore run-to-run variance rather than a
cost — one draw call and ~2 000 triangles came OUT of every void frame.

`clip lo` moved from 0.00-0.01% to 0.01-2.18%, which is the first real crushed
black the void has had; §2 asks for 2-8% but the reference file itself measures
0.21%, so the file wins and the row is now annotated to say so.

`plunge` is the one shot whose numbers moved the wrong way (p50 27.4 -> 19.7,
spread 20.1 -> 15.2), and that is the far cards' pale wash leaving. Beside the
reference the frame is better for it: ruin towers with window openings and dark
gaps between them, where before there was a violet field with chips in it.

`summit` is unchanged and remains the weakest frame in the set — lum 61.3
against §2's 28-55 and 3.17% clipped high. Nothing in this change could help
it: the blow-out is the 26 m finish plaza filling the bottom 60% of the frame
at 5 m with an emissive rune inlay in it, and the sky is the part of that shot
that is now right. It stays on the roadmap against `tools/shots.mjs` and
`src/levels/void.js`.

Skyline is untouched and measured so: `closeup` lum 111.1, sat 0.807, and its
sky is still entirely procedural — the dome branch is gated on
`theme.sky.dome`, which only the void sets, so the skyline build never fetches
a byte of the image.

## 2026-07-26 — the far band is baked, so it can afford to be crowded

Ethan's standing note on the void is that the build has "less depth and detail
in the backdrop and less overall objects" than
`docs/reference/theme2-void.png`. The reference's far distance is layer on
layer of ruins; ours was 306 prisms scattered round a ring. The far band of
`src/fx/voidbackdrop.js` is now **baked impostors**: ruin clusters rendered
once at boot into a texture atlas and drawn as camera-facing cards at their
real world positions.

**What it actually cost, measured, because the premise needed checking.** The
brief expected the three bands to be ~1.2 M triangles. They were 30 088, of a
void frame that renders ~2.94 M (the course is drawn three times a frame:
shadow maps, depth/normal prepass, beauty). The far band alone was **7 344
triangles — 0.25 % of the frame — and 1 draw call**. Toggling it off inside a
running page moved the frame by **0.00 to 0.08 ms**. So there was no triangle
problem to solve, and converting it to cards "to save triangles" would have
been a rounding error dressed up as a win.

The win is the exchange rate. A card is 2 triangles and carries a whole ruin
CLUSTER — 6 to 11 masses, slabs and spires overlapping in depth:

| | far band before | far band after | same density as geometry |
| --- | --- | --- | --- |
| draw calls | 1 | 1 | 1 |
| triangles | 7 344 | **1 976** | 152 472 |
| apparent ruins | 306 | **~8 400** | 6 353 |
| ms/f (isolated, on minus off) | 0.00-0.08 | **0.11-0.26** | 0.26-0.39 |

The right-hand column is the control that makes this a real result: the same
crowd built the old way costs **77x the triangles and about double the frame
time** of the baked version. Whole-frame numbers move by less than the
machine's own noise — draws unchanged at 95/85/119/93, triangles down 6 328,
ms/f inside +/-0.3 on an interleaved A/B — which is the correct outcome for a
layer that was already cheap: the frame did not get slower and the backdrop got
27 times as much in it.

**The five things this had to get right**, all argued at length in the file:

- **It still parallaxes.** Every card is at its own world position, so climbing
  508 m through a 142 m radius sweeps a card at 950 m by 8.5 degrees of azimuth
  and up to 45 of elevation — all real. Only what is baked INTO the card is
  frozen, and that error is bounded and measured: intra-cluster parallax is
  b*t/d^2 = 142x150/880^2 = 1.6 degrees, ~18 px, accumulated over the whole
  climb. Under a tenth of what the card's own motion provides.
- **Elevation is not azimuth.** +/-45 degrees is far too much to freeze, so it
  is baked as **five slices across +/-50 degrees** and cross-faded per fragment
  between the two that bracket the camera. Re-baking on a threshold was
  rejected: it puts an unbounded GPU spike on an arbitrary frame during play to
  fix what a fifth of a megabyte fixes at boot.
- **The fog is applied exactly once, at runtime.** The atlas stores shading
  INPUTS, not shaded pixels — R the hemispheric up-factor, G the rim term, B
  the per-piece value wobble, A coverage. The card's shader then runs the same
  body-and-haze arithmetic the geometry bands run, off the same uniforms and
  the same `scVoidGradient`. So a card cannot arrive un-hazed or double-hazed,
  the palette stays live under a theme change, and 8 bits is plenty because
  every channel is a 0..1 factor rather than a dark colour that would band.
- **There is no sort.** Alpha-BLENDED cards would need back-to-front order
  against each other and the two geometry bands every frame. These are
  alpha-TESTED with depth write, which is order-independent by construction;
  the usual cost — a staircase silhouette — is paid off by rescaling coverage
  into one pixel either side of the contour and handing that to
  `alphaToCoverage` against the pipeline's existing 4x MSAA scene target.
- **Nothing is reachable.** The cards go through the same `assertClear()` as
  the prisms, as boxes of their full world size. Closest approach 214.9 m
  against a 140 m minimum.

Two things found on the way that are worth keeping:

- **The haze had to move to the vertex shader.** The cards cover the shell
  about 1.4x and the quads carrying them far more, so `scVoidGradient` per
  fragment cost 4-5 ms/f — the first working build was slower than the
  geometry it replaced. It is a smooth function of view direction over a shape
  a few hundred pixels across, so four corners and an interpolation are
  visually identical and an order of magnitude cheaper. The geometry bands,
  which cover a few percent of the frame, keep theirs per fragment.
- **Past the far plane, squash rather than clip.** The ring runs 780-1010 m and
  the cards +/-980 m vertically, so from the plaza the highest are 1 400 m out
  against a 1 200 m far plane — the old band simply vanished there, which is
  the hard cut across the top of `summit`. `VERT_CARD` maps everything beyond
  0.99 NDC into the last 1 % of the range monotonically, so order survives and
  nothing is cut.

**Bake cost: 43-55 ms, of which 11-15 ms is CPU geometry.** It runs inside
`buildWorld` at boot, before the first frame is presented — about 3 % of the
1.4 s from navigation to a playable game. Every archetype x slice is baked in
ONE draw call: rotating a cluster by an elevation and viewing it head-on is the
same picture as viewing it from that elevation, so all 80 tiles are pre-rotated
and pre-translated into their atlas cells and merged into one buffer, and the
camera never moves. Building that buffer with a `Vector3` per vertex cost 42 ms
on its own; flat arithmetic on typed arrays took it to 11.

First build of the clusters was wrong in a way worth recording: twelve small
stones per tile baked down to a spray of two-texel chips, and a thousand of
those cards is gravel, not a ruined city. Density is the CARD count and detail
is the PIECE count, and conflating them is what produced it. The lead mass now
owns a third of the tile, `IMPOSTORS.pieces` is 6-11, and the rubble class is
rare.

Gate green, `tools/coverage.mjs` unchanged at 90.50 m2, skyline untouched
(`closeup` lum 111.1, sat 0.807 — the theme does not build this layer at all).

## 2026-07-26 — the void stops being dark-on-light

A harsh review of the rendered frames, and it was right about the biggest thing
in the theme:

> The void has a sky and a horizon: the backdrop is the brightest thing in
> every frame, so all geometry reads as black cutouts.

`summit.png` was the proof — the top 45% a flat lavender gradient with a clean
silhouette line across it at y≈380. That is a horizon, and §3 ends "there is no
sun and no sky. Anything that reads as a horizon line is wrong"; §8 lists "a
visible horizon" among the named failure modes. `plunge` and `midclimb` were
the same inversion at lower contrast: 55-65% uniform bright violet with every
object darker than it.

The reference is the opposite, and measuring it settled the argument —
`docs/reference/theme2-void.png` comes back at lum 47.1, p50 41.1, p1 4.2,
sat 0.704. The mass is LIT and the space behind it is dark. §1 says so in
words: "lit BY OBJECTS and shaped by darkness".

- **The background came down about three stops** (`sky.zenith` 0x120b26 ->
  0x040310 -> 0x070413, `sky.horizon` 0x3b2058 -> 0x241238) and **the light on
  the mass came up to meet it**. Both halves are required: the dome is also the
  source of the pipeline's analytic sky IBL, so darkening it alone darkens the
  rock with it and the value ORDER never changes.
- **The key light is raked shallow** — `sunDir` [-0.35, 0.62, 0.70] ->
  [-0.52, 0.26, 0.81]. At 62% vertical the strongest light in the level fell on
  platform tops and on the finish plaza, which is most of `summit`; that one
  shot measured lum 75 while the three that look along the shaft sat at 38-42.
- **The grade's gamut guard is all but off** (`gamutDesat` 0.55 -> 0.10,
  `gamutKnee` 0.62 -> 0.78). It pulls any over-knee pixel toward its own
  luminance, which is right for one clipped terracotta roof and catastrophic in
  a world where every beam, sigil, rune and orb passes the knee. The anchor orb
  authored violet was arriving at rgb(211,204,213) — the review read it as a
  moon, correctly.
- **Saturation 1.60 -> 1.08.** Measured against the reference the build was
  MORE saturated than its target (0.88 against 0.704) and starved of green,
  which is what made every rock face electric royal-blue instead of violet.
  `surfaces.macro.shade` lost its 35% blue skew for the same reason.
- **The far bands stop being fog banks.** `src/fx/voidbackdrop.js` ran its
  inscatter gains at 0.95/1.50/1.85 so the layer rendered LIGHTER than the dome
  at every range — correct only while the dome was the brightest thing in the
  frame. Gains are now at or below 1.0 and the bands carry their own body
  brightness, so they read as mass receding rather than as a lit backdrop.
- **The drifting motes are clamped and near-faded** (`src/world.js`). The
  projection was honest and unbounded, so a mote at one metre subtended 144 px.
- **`exposure.clampHi` raised 6.0 -> 12.0.** Found while tuning: with the EV
  pinned at -3.5, `exposure = 2^compensation / (1.2 * 2^EV)` hits the default
  ceiling of 6.0 at a compensation of about -0.65, so every value above that
  produced a byte-identical frame. The theme's headline dial was dead against
  its stop. It is live again.

Measured, void shot set, before -> after:

| shot | lum | p50 | clip lo | clip hi |
| --- | --- | --- | --- | --- |
| ascent | 28.9 -> 38.7 | 11.8 -> 23.0 | 2.62% -> 0.01% | 0.82% -> 0.30% |
| midclimb | 46.5 -> 34.9 | 36.0 -> 22.7 | 0.33% -> 0% | 0.25% -> 0.30% |
| plunge | 51.5 -> 34.8 | 52.0 -> 28.4 | 1.83% -> 0% | 0.42% -> 0.28% |
| summit | 54.5 -> 60.9 | 34.2 -> 35.5 | 0.56% -> 0% | 3.49% -> 3.17% |

All four now sit inside §2's `p50` band and three of four inside its `lum`
band. `clip lo` moved AWAY from §2's stated 2-8% and toward the reference,
which measures 0.21% — that row of the table is not a number read off the
image, whatever §2 claims, and the frames are judged against the file.

Skyline unchanged: `closeup` lum 111.1, sat 0.807, and `bash tools/ship-gate.sh`
exits 0. Draws 85-119, 2.94M triangles, 3.2-4.9 ms/f — unchanged from before.

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
