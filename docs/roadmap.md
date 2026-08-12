# Roadmap

## Owner direction — 2026-08-02 (Ethan, test-packet reply; NOT a priority now)

Verbatim intent, filed for whenever this repo is next promoted: "we need more
levels, more like the initial one less like the void, more basic but
intentional, allowing players to more fully explore all ways of parkour
combinations in the game, and a much bigger total map. but not a priority
right now. It will take lots of tokens." So: future level work biases toward
theme-1-style courses over Void-style ones, breadth of parkour combination
space over spectacle, and total map size. No lanes on this until Ethan
promotes it.

## Now — the Void (theme 2)

- [ ] <!-- workspace:id=work:0c8828c8-c3d2-5764-ac90-af86792908a5 --> **Contact shadows split by quality tier (Ethan, 2026-08-01 approvals
  packet):** full-resolution contact shadows in the highest graphics preset
  only; half-resolution in every other preset. Wire through the existing
  quality-level knob in `src/render/quality.js`.

Acceptance is `docs/art-direction-void.md` §2, measured by
`node tools/shotset.mjs --theme void`. The sky, atmosphere, exposure and
energy beams landed 2026-07-25, and the distant scenery layer and the
six-beam rewrite landed the same day (see the changelog); what is still short
is listed here rather than in a reviewer's head.

- [x] <!-- workspace:id=work:fd4bab85-e08e-57c1-9612-6d8bbbf6e5e9 --> 2026-07-25 — glowing veins and cracks through the rock. The reference's
      dark masses are threaded with magenta and violet fissures lit from
      inside, and the build had none; it was the most conspicuous single gap
      left. Added as an emissive mask in the ORM map's spare red channel,
      painted on its own fault network in `paintGlowVeins`
      (`src/materials/textures.js`), lit by `SC_VEIN` in
      `src/materials/shader.js`, and enabled only by `theme.surfaces.veins`.
      Zero extra draws, tris or texture fetches; skyline compiles none of it.
      See the changelog.
- [x] <!-- workspace:id=work:9342f1de-05cf-51ca-8b90-8530a61810f7 --> 2026-07-26 — the void was dark-on-light. The backdrop was the brightest
      thing in every frame, so all geometry read as black cutouts and `summit`
      carried a clean horizon line across it — §3's "anything that reads as a
      horizon line is wrong" and §8's named failure mode, both. The background
      came down about three stops, the light on the mass came up to meet it,
      the key was raked shallow so it lands on walls instead of floors, and the
      grade's gamut guard was all but switched off so emissives stop printing
      as white objects. `plunge` p50 52 -> 28.4, `summit` lum 79 -> 60.9, and
      all four shots now sit inside §2's `lum` and `p50` bands. See the
      changelog.
- [x] <!-- workspace:id=work:417d8a49-c71a-5eef-b2de-534d845628f7 --> 2026-07-26 — the void's far distance is a painted dome, not prisms.
      Ethan on the impostor build: "honestly the random shapes in the
      background is very weak hoping the image method will improve it."
      `public/sky/void-dome.png` is now the sky dome (tiled 4x, void theme
      only), composed as a modulation of `scVoidGradient` so the sky stays one
      evaluation, with a ceiling strictly under the background's own so the
      value order cannot invert. The baked impostor far band is deleted — ~650
      lines, one draw call, ~2 000 triangles and a 16 MB atlas out of every
      void frame. See the changelog.
- [ ] <!-- workspace:id=work:2a5214e0-1b0f-59e6-8cab-62082739cb3e --> `summit` still measures lum 61.3 against §2's 28-55 and 3.2% clipped high
      against 0.3-2.5%. Both come from the shot itself rather than the theme:
      the 26 m finish plaza fills 60% of the frame at 5 m and its rune inlay is
      an emissive at that range. §5 says "look up, not down"; the fix is either
      a recomposed `summit` in `tools/shots.mjs` or a quieter inlay intensity in
      `src/levels/void.js`, and both belong to the lanes that own those files.
- [ ] <!-- workspace:id=work:628365c0-22fc-5a36-9697-012753fe035e --> The grapple-anchor orb still blooms to near-white. `levels/void.js`
      draws it at `intensity: 2.1`, which rides far enough up AgX's log range
      that its hue is gone before any grade runs; pulling `accents.lantern`
      down to 0x5c18c0 moved it from rgb(211,204,213) to rgb(210,185,213) and
      no further. The intensity is the dial and it lives in `src/levels/void.js`.
- [ ] <!-- workspace:id=work:287c46b2-452f-5882-88bc-fec564400adc --> The fissures do not move. They are a static emissive mask, so a crack
      cannot pulse, breathe or flare as the player passes. That wants a time
      uniform driven from the frame loop, which is `render/` and `main.js`
      territory rather than a material's.
- [ ] <!-- workspace:id=work:df4681fb-8327-5eb7-ab3a-73590346b849 --> The fissures light only themselves. Nothing near a vein is lit BY it —
      no bounce onto the rock beside it, no contribution to the crystals or
      the motes. A real answer is a cheap per-fissure point light or an
      irradiance-volume term, and both are a lighting-budget decision (§7.3)
      rather than a surface one.
- [x] <!-- workspace:id=work:462ea566-03bd-5328-bb2d-65f2f38068f0 --> 2026-07-26 — the far band is BAKED. It was 306 extruded prisms carrying
      306 apparent ruins; it is now 988 camera-facing cards baked from the same
      generated geometry into one 2016 px atlas at boot, carrying ~8 400
      apparent ruins for 1 976 triangles — 27x the objects for 27% of the
      triangles, in the same single draw call. Parallax survives because every
      card sits at its real world position; elevation is baked as five slices
      and cross-faded; the fog is applied once, at runtime, because the atlas
      stores shading FACTORS rather than pixels. Measured: the layer costs
      0.11-0.26 ms/f against 0.00-0.08 for the prisms it replaced and 0.26-0.39
      for the same density built as geometry. See the changelog.
- [ ] <!-- workspace:id=work:db89c8aa-65ca-5283-be3d-4b82b71e6fe9 --> The far bands carry no light of their own. `src/fx/voidbackdrop.js` puts
      two distance bands behind the course, but every mass in them is unlit
      rock seen through haze. The reference has pinpricks out there — distant
      sigils and crystal glints — and they are most of what sells the scale.
      Wants an emissive speckle channel on the backdrop shader, kept rare
      enough that §3's "red must stay rare" still holds at a kilometre. (The
      painted dome already carries a few faint magenta glints of its own; this
      item is now about the two GEOMETRY bands only.)
- [ ] <!-- workspace:id=work:7d353115-4d09-53bf-947c-75b07b3460b6 --> Emissives in the emissive-poor shots. `tower`, `deckstrip` and
      `edgefeet` miss §2's `p99 > 215` and `clip hi 0.3-2.5%` for one reason:
      there is nothing bright in frame. This is §4.1-4.3 work — sigil rings on
      the great walls, rune inlays on platform tops, crystal clusters — not an
      atmosphere tune, and no amount of exposure will fake it.
- [ ] <!-- workspace:id=work:3c07f58f-5748-5363-8847-aa48b6922a81 --> True black in the up-looking shots. `vista`, `underside` and `edgefeet`
      come back at `clip lo 0%` against a target of 2-8%: they contain no
      surface deep enough in shadow to reach it. Needs mass that occludes —
      §4.1's great walls — rather than a darker grade.
- [ ] <!-- workspace:id=work:71808b34-b20a-57ed-b869-f88ef4e9eae1 --> `crossing` and `closeup` sit above §2's `lum` band (63 and 75 against
      28-55). Both are close-range shots of lit stone, so they are measuring
      the SURFACES, which are still the skyline theme's porcelain and marble
      under a violet light. They should come into band with the void's own
      rock (`#14101F`-`#2A2438`, §3) and not before.

## Now — the look, round three

Two adversarial rounds took the critics' score from 24/100 (AMATEUR) to an
average of 52/100. The technique from the first list is all in the build; what
is left is not more technique, it is **value, colour and silhouette** — the
three things the critics still agree are wrong. Reference frames for every item
below are the 8-shot set from `node tools/shotset.mjs`.

Ordered by how much each one costs the frame, worst first.

### The cloud sea does not exist

- [ ] <!-- workspace:id=work:cb5aeaf5-8599-5454-8625-c513bb702161 --> Build a real cloud deck. `SKY_FRAG` in `src/world.js` fires the deck
      shader but produces one screen-filling blob: `t = -1.0/h` assumes the deck
      is 1 unit below the camera, and `cp = d.xz * t * 0.055` then spans ~0.2
      noise units across the whole lower screen. Use a real deck altitude
      (`t = (camY - DECK_Y) / -h`, `DECK_Y` 60–100 m below the lowest island)
      and a planar scale near 0.9–1.4 so billows are tens of metres.
- [ ] <!-- workspace:id=work:5e9596eb-634b-5d84-89e6-a5d4889b61bc --> Widen the deck's value split. Shade is `uGround*0.80` against
      `mix(uGround, uSunColor, 0.42)` — under 20% apart, which is why it reads
      as a flat gradient. Take shade to ~0.55 with a cool green-blue lean and
      let the silver-lining term (`pow(sun, 6.0)`) run at 1.0+. Add a second,
      slower, larger-scale layer for silhouetted banks near the horizon.
- [ ] <!-- workspace:id=work:edc6bd95-c6e2-5e82-93c2-786e89db071b --> Sky-coupled fog. `scene.fog = FogExp2(0xffdcae, 0.0052)` is one constant
      that cannot agree with a sky running 0x5589a0 at zenith through 0xffd9a4
      at the horizon to a cloud deck below, so distant islands go cool
      blue-white against a warm tan sky and pop forward as cutouts. Sample the
      fog colour from the same sky evaluation in the view direction, or at
      minimum pitch-lerp between `uGround` and `uZenith`. Drop density to
      ~0.0030 with a height falloff so mid-distance islands survive.
- [ ] <!-- workspace:id=work:3892315a-bed6-5098-bc4d-a46e1c8f7ece --> Retint aerial perspective toward the sun colour (~0xE9B57A) rather than
      toward blue-white, sun-angle dependent. Target `regionSpread` above 65 on
      `vista.png`; it is 49.9 today, the lowest of the set.

### Nothing is dark

- [ ] <!-- workspace:id=work:90c2bcbd-fc49-5c60-bb1f-3cadc2e60dd7 --> Put a real toe under the grade. Every shot measures 0.00% clipped low and
      p1 between 38.8 and 57.4 — dynamic range ~144/255 with no black in it.
      `GRADE.offset [0.001,0.002,0.003]` plus the AgX toe leaves a floor with
      nothing below it. Add a filmic toe (or drop slope slightly) so genuinely
      occluded geometry reaches 8–15 code values instead of 40+.
- [ ] <!-- workspace:id=work:c07264fc-46cb-5243-97d8-02d051c2481f --> Add a short-radius tap set (0.15–0.3 m) to `src/render/contact.js` for
      interior corners, alongside the existing broad AO radius. Acceptance:
      `tower.png` and `closeup.png` both come back with p1 < 25, and the
      wall/floor junction in `closeup.png` shows a visible darkening band.
- [ ] <!-- workspace:id=work:57511a60-e385-55ad-bf10-68c5d6acf4b1 --> Model the chamfers instead of hoping AO fakes them. Give `kit.js`'s step,
      cornice and string-course helpers a 3–5 cm bevel course inset from the
      mass below, so every horizontal edge self-shadows. The balustrade already
      does this and is visibly the best-reading geometry in the set.

### The floor is green

- [ ] <!-- workspace:id=work:3f555bf2-e117-52c0-9d2a-d7737b317dfb --> Split the shadow tint off display luminance. `GRADE.shadowTint`
      `[-0.026,+0.034,+0.015]` at `shadowFalloff 1.85` in `src/render/lut.js`
      greens every dark texel whether it is lit or not, and `GRADE.saturation
      1.30` amplifies it (the file's own comment measures 0.12 in / 0.69 out).
      Cut green to ~+0.018 and move the split to the lighting term in
      `src/render/patch.js`, where it can see the actual shadow/ambient ratio.
- [ ] <!-- workspace:id=work:c6712429-2b7a-5de4-8337-e00ac6028ebc --> Stop paving with `PALETTE.stone 0x8e968b` (hue 96). Its own comment in
      `src/materials.js` says it drives "a good deal of the paving"; restrict it
      to island undersides and boulder mass and pave with the sandstone albedo.
- [ ] <!-- workspace:id=work:fbc25bc6-e188-52bf-97a0-562721bbe8fe --> Clamp the cool-shadow term on up-facing normals by
      `1.0 - 0.6 * max(0.0, N.y)` so treads keep their sandstone value while
      vertical faces keep the green shadow. Today the ascent stair in
      `tower.png` is a ~2.5-stop value inversion — bright risers, dark treads —
      and does not read as a stair at all.

### Brass reads as painted board

- [ ] <!-- workspace:id=work:6e4f3663-c666-51c2-9640-c235b09a0b9f --> Drive roughness from the ornament height field: ~0.18 on raised bands and
      rosette rims, 0.38–0.55 in the recessed field, so the specular breaks into
      legible shapes instead of one sheet. Plate roughness is uniform today.
- [ ] <!-- workspace:id=work:698b90cc-d837-5643-a68d-f8cc1c63ddab --> Bake a cavity/AO term from the same height field and multiply it into
      albedo at band channels and medallion undercuts at 0.55–0.65 strength.
      That is what puts dark in the crevices; there are none now.
- [ ] <!-- workspace:id=work:22c52a87-df01-5b21-9d16-395b25fcf271 --> Add a verdigris mask — `smoothstep` on downward-facing normals plus
      low-frequency noise, tinting toward ~0x4e8f7a at ~0.35 in crevices.
- [ ] <!-- workspace:id=work:3cabee42-b18e-59ec-8af3-9fb0ff88afb2 --> Roll the brass specular off in the AgX shoulder in
      `src/render/composite.js` so a grazing wall-run angle cannot clip the
      panel to white. `underpass.png` still clips 2.77% high; dropping
      `SURFACE.brass.glint` 1.5 → 1.15 did **not** move that number, so the
      clipping is coming from somewhere else and needs to be found first.
- [ ] <!-- workspace:id=work:b190367f-e7b8-5a0d-9c9c-214ff6f6361b --> Feed `src/render/skyenv.js`'s gradient into the specular so a long panel
      picks up sky at one end and sun aureole at the other.
- [ ] <!-- workspace:id=work:41b73859-a33f-515f-a30d-8f0da7a8f8b1 --> Give the gear and rosette ornaments real relief. The macro layer in
      `src/materials/shader.js` is documented as handling "everything ABOVE the
      size of a tile" and these fall through the gap. Either promote the hero
      rosettes to extruded geometry in `kit.js` (few, low-poly) or give the tile
      a height-derived normal, a cavity term at the tooth roots, and a parallax
      offset at grazing angles.
- [ ] <!-- workspace:id=work:f15fc50c-d48d-5d29-868f-ad6bf78d07f0 --> Kill or commit the faint secondary ring layer on the brass — at its
      current opacity it reads as z-fighting, not as ornament.

### Every island is the same island

- [ ] <!-- workspace:id=work:45067e86-3b8e-581f-bac1-4d8d200fd492 --> `discRects()` (`src/kit.js:290`) is fully deterministic in `r` and
      `facets`, so every `drumPlatform` of a given radius is geometrically
      congruent — twelve identical silhouettes in `gaps.png`. Pass the
      platform's deterministic `rand` in and jitter each rect's `hx`/`hz` by
      ±8–12% independently, **inward only** from a nominal R so the collision
      union never grows past what the caller reserved. Vary `squash`
      (0.75–1.35), `tiers`, and the per-tier inset ratio 0.68.
- [ ] <!-- workspace:id=work:462db325-5bd3-5733-beb5-e68cadd0d5d9 --> Kill the voxel undersides. The boulder lumps at `src/kit.js:449-456` are
      emitted with `{ rot: { axis: 'y', angle: a } }`, and that is the only
      rotation anywhere in `kit.js` — a Y-rotated cuboid is still a cuboid, so
      the lumps read as the same countable cubes as the tiers they were added to
      hide (`crossing.png` bottom-centre, `chain.png` centre). They are decor
      under an overhang, so they are free of the AABB collision constraint: give
      `rot` a full quaternion, tilt 12–30° on X and Z too, and add a `blob`
      primitive (bevelled box or icosahedron on a superellipsoid) with
      non-uniform per-axis scale. Leave the SOLID tier discs alone.
- [ ] <!-- workspace:id=work:71b2da61-0af4-5b6d-8377-cb0a40db05f8 --> Give the moss cap thickness. Extend the moss volume 10–15 cm past the
      stone drum and darken that overhang band; break the top with per-vertex
      value jitter of ±12% and hue drift across 75–105° (the vertex-colour
      channel `level.js` already uses for tint jitter is free); match the cap's
      chamfer to the drum's to kill the corner gussets visible in `gaps.png`.
      Drop overall moss value so sandstone, not moss, is the brightest surface.
- [ ] <!-- workspace:id=work:78bd61e4-c14e-5d6f-9892-20a123928f52 --> Give the moss texture a low-frequency clump mask (2–3 octaves at ~1.5 m
      and ~4 m) modulating both value (±18%) and hue (8–12° toward yellow-green
      in clumps, blue-green in hollows). Darken the outer 1.5 m toward the rim.
- [ ] <!-- workspace:id=work:34e93dc7-ffb4-5c2b-8335-f04492dacd6d --> Make the moss lip opaque. It is visibly translucent with a glassy sheen —
      the red cornice reads straight through it — so it looks like green film
      taped to the edge, and from above it presents as a walkable ledge. Opaque,
      vertex-displaced lower edge, outer extent inside the collider footprint,
      underside darkened hard.

### Colour discipline

- [ ] <!-- workspace:id=work:6c5b206c-34f8-57ef-ba86-6cef9da490d5 --> Pull `PALETTE.terracotta 0xc34a26` (`src/materials.js:64`) to something
      near 0xC0764E. At ~0.80 saturation, amplified by `GRADE.saturation 1.30`,
      it is safety-cone orange — the entire mid-mass of `underpass.png` and the
      rim of every island. The brief says "sandy peach and ochre".
- [ ] <!-- workspace:id=work:48340f60-e0dc-59d6-9590-131ba90554ac --> Break the rim course. `kit.js:419` emits one continuous ring at one
      radius, so each island reads as a three-layer cake: green plate, red
      stripe, grey block. Jitter each block's radius ±6% and height ±20%.
- [ ] <!-- workspace:id=work:02b7a12d-919d-5097-ba1e-14a5d33abca3 --> Reserve one chroma channel for interactables. The same saturated red is a
      vault cap (a good, learnable signal, `terrace.png`) *and* the cornice of
      every scenery island the player can never touch. Add an `accent` flag to
      `solid()` in `level.js` and assert in a dev build that no `decor()` call
      uses the accent material; repaint decor cornices in desaturated ochre.
- [ ] <!-- workspace:id=work:cede6e8f-c4fe-577f-96f4-6bdda33e149f --> Add per-face value variation to the terracotta slab and confirm the
      `underpass.png` overhang is actually shadow-casting — a 40 cm overhang at
      a 10° sun should lay a long dark band across the wall beneath it.

### Vegetation is missing from the architecture

- [ ] <!-- workspace:id=work:31230750-2ea4-55c8-9ca6-89e5b563264b --> `tower.png` has an arch, two colonnades, a stair, a terrace and six blocks
      and is 100% bare stone; `terrace.png`'s floor-to-wall junctions are
      perfectly clean hard lines. `vineCurtain` exists and is only ever hung off
      island rims — hang it off colonnade architraves, arch springings and
      terrace rims too. Target: no frame contains a stone mass over ~3 m wide
      with a completely unbroken top edge.
- [ ] <!-- workspace:id=work:ea7e50fa-11ec-5696-a311-5aff2908b37d --> Add `mossWedge(edge)` as a kit primitive — a triangular-section strip
      auto-emitted at every horizontal solid/solid junction, jittered in height
      along its run. Emit as decor, below step height, so it cannot become a
      phantom surface. (The shader-side moss creep landed; the geometry did not,
      and the shader term alone is not visible at the wall bases in `closeup.png`.)
- [ ] <!-- workspace:id=work:29f112d5-1a18-5fc1-9ee0-9f93f38b0748 --> Scatter 15–25 tuft cards and 5–8 flower clusters per island from the
      island's `rand`, under 20 cm tall so they never impersonate a ledge.

### Wayfinding

- [ ] <!-- workspace:id=work:a6cbaeea-6d99-5b2e-95f6-08a8425c794d --> Rebuild the goal beacon (`level.js:489 _beacon()`). It renders as a ~4 px
      uniform non-animated white stripe, barely brighter than the sky, and in
      `tower.png` the arch keystone bisects it. Wanted: a soft-edged additive
      shaft, radius and intensity pulsing ~0.4 Hz, a core well above the AgX
      knee so it survives the tone curve, a ground-flare disc at its base, and
      depth-test off after opaques so architecture never cuts it.
- [ ] <!-- workspace:id=work:f7e67b10-ffc6-54f8-9941-fd9636f81631 --> Rebuild the checkpoint gate. In `terrace.png` it is a thin low-contrast
      brass wire ring at the right edge of frame, off the running line — it will
      not be seen at 47 km/h. Centre it on the run line at chest height, ~2.5 m,
      driven from `player.position`: hot brass emissive plus slow rotation
      inside 60 m, fading to a faint outline beyond.

### HUD and FX

- [ ] <!-- workspace:id=work:dbbd764c-1a9e-5ce7-8da2-9763e038308a --> **The wall gauge only covers the two wall verbs.** The dash (`dashTimer`)
      and the grapple (`grappleTimer`) have exactly the property it was built
      for — a budget that runs out and then simply stops — and both currently
      end without warning. Deliberately not done in the same pass: three more
      gauges arriving at once is how an instrument panel becomes chrome, and
      the wall pair earned its place by being the thing that was actually
      reported. Decide whether the DASH and HOOK chips should drain rather than
      merely light, which would cost no new elements at all.

- [ ] <!-- workspace:id=work:8d266b0a-133a-56aa-b4b8-a6db46cb0489 --> The reticle is a 5 px translucent dot (`index.html:35-45`) and is
      invisible against gold and against the specular blowout. Build it from a
      2 px dark outline plus a light core; grow the `.hot` state into a 3-arc
      brass ring that closes on lock; add a screen-space anchor marker at the
      grapple target so the player aims at the world, not at a corner chip.
- [ ] <!-- workspace:id=work:731eba87-d1ee-5533-996e-053f4a6fe775 --> Move the checkpoint toast to ~15% from the top, out of the landing read,
      with a dark scrim or a 1 px warm rule and an arrival punch. Give the
      timer, speed and chips a 1 px dark stroke — a soft shadow does nothing
      against a 220-luma sky.
- [ ] <!-- workspace:id=work:9432fa6a-ae31-5a64-8c45-096568e140dc --> Near-fade the wind streaks. `src/fx/speed.js` `_updateStreaks` spawns at
      `ahead = 3 + rand*10` m and the camera flies through them, so a 2.8 cm
      quad passes centimetres from the lens — visible as pale bands over the
      stair treads in `tower.png` and over the moss landing in `gaps.png`.
      Multiply alpha by `smoothstep(1.2, 4.0, -mvPosition.z)`, raise the minimum
      spawn to ~6 m, and widen the angular floor from ~27° to ~40° off the
      travel axis (horizontal half-FOV is ~50°, so 27° is not peripheral).

### The void kit — what `src/voidkit.js` left open

Found while building and photographing the void ruin prefabs (see
`docs/changelog.md`, 2026-07-25). None of these are in the voidkit lane.

- [x] <!-- workspace:id=work:fbbd4efe-f347-5888-a16e-36ff2602e96c --> **The void's rock is not dark.** (2026-07-25) Repointed per theme rather
      than shaded down: `theme.surfaces.kinds` is a per-theme alias map read by
      `materials.js` `resolveKind`, and the void maps `stone` → the new
      `voidrock` painter — near-black violet riven rock, built from a fracture
      field rather than from `stone`'s domes. `surfaces.shade` is set to an
      explicit 1.0: a vertex tint can only remove value, and §3 asks for a
      violet cast, not a darker grey. See `docs/changelog.md`.
- [ ] <!-- workspace:id=work:e95acc8b-5776-52c6-84bd-5208dc792bb1 --> **A hardcoded warm rim is what actually lights the void's rock.**
      `scHazeSun` in `render/patch.js` is `0xfff0d2 * 1.5` — the golden hour's
      haze — and it is added to every surface as a Fresnel rim, at the void's
      doubled `aerial.rim` of 0.32. Measured on `ascent.png`: with the rim on,
      a lit rock face is rgb(104,69,61), hue 10 — tan. With `rim: 0` the same
      face is rgb(1.0,0.9,7.1), i.e. the rim is supplying essentially ALL of
      the light on the mass, and supplying it warm. The surface lane has taken
      the albedo as far as it goes (shaded faces now land at hue 266 against
      §3's 268); the lit faces cannot be fixed from `materials/*`. `scHazeSun`
      needs to become theme data alongside `setAmbientUpColor` /
      `setAmbientDownColor`, which are already seams and are also still on
      their golden-hour literals (`0x8fd8c4` / `0xffcf96`).
- [ ] <!-- workspace:id=work:d561a305-9248-5307-b4be-3f729cec345b --> **The void's IBL is still the golden-hour dome.** `render/skyenv.js` has
      no void mode: its peach horizon (`0xffcfa0`), gold aureole and sunlit
      cloud deck (`0xffd7a8`) are what `scene.environment` holds under
      `?theme=void`. `render/index.js` already passes `options.sky` and the
      class already has `setColors`/`setGains`; the void descriptor's `sky`
      block does not reach it. Measured as second-order for now rather than as
      a cause: dropping both void surfaces' `envMapIntensity` from 0.85 to 0.12
      produced a bit-identical frame, so the warm dome is not what is currently
      lighting the rock. It becomes the largest remaining ambient term the
      moment the rim above is fixed.
- [ ] <!-- workspace:id=work:b0f974d2-a14a-5f55-9098-355190659da7 --> **The void still draws a cloud sea and a warm horizon band.**
      `world.js`'s cloud deck renders under the void theme, giving exactly the
      readable horizon line §3 says is wrong ("there is no sun and no sky").
      Visible in every frame of `docs/captures/voidkit/`.
- [ ] <!-- workspace:id=work:4f1eb429-4c2c-5e79-aff3-01ed6a839e26 --> **The wall-run face goes unreadable under the void's key light.** The
      panel grooves and their 7.5 cm arrises read clearly under `?theme=skyline`
      and nearly vanish at `keyIntensity: 0.35` with no crystal in the scene.
      Geometry is doing what §6 asks; the light is not reaching it. Likely
      answers are crystal fill near the run band or a bounce term, not more
      relief — more relief would break the flat run plane.
- [ ] <!-- workspace:id=work:74f8ca6e-61c0-5d70-83a5-2d50474ccaa1 --> **`voidkit` prefabs are not in a course.** They are exercised only by the
      scratch stage, so they have never been judged from the gameplay camera on
      a real route, and `trackedVoidKit().assertAllPlaced()` guards nothing yet.
      Wire them into the void course and fold `tools/voidshots.mjs` into the
      ship gate, or delete the stage.

### Far LOD

- [ ] <!-- workspace:id=work:c5fb89bf-1d1f-5cd7-b21c-a68de70c0496 --> Replace the box-on-a-disc impostor with a silhouette carrying a moss cap,
      a tapering underside and one vertical brass or cypress accent. Silhouette
      variety is what makes an archipelago read, and at that range it is nearly
      free.

### Hidden colliders that still overhang their mesh

Audited numerically by `node tools/hollow.mjs`, which walks every hidden
collider in the real course and measures how far its boundary is from the
nearest drawn triangle. The big ones are fixed; these two are measured, judged
minor, and left on purpose rather than missed.

- [ ] <!-- workspace:id=work:bc46a82b-4b3c-5aa6-b3eb-49b6ffc016c2 --> `drumPlatform` boulder tiers (`kit.js`, the `disc(S, ..., tr, h, ...)`
      inside the tier loop): the `blob()` drawn inside a tier reaches its
      collider's across-flats radius only where the noise happens to peak, so
      the tier collider stands up to **4.06 m** outside the drawn rock on 17 of
      268 solid islands. It cannot be seen through — the collider is never
      drawn — but it is an invisible ledge a falling player can land on. Fix by
      sizing the tier collider from the blob's MEASURED silhouette rather than
      from its worst-case bound, and re-run `tools/hollow.mjs`.
- [ ] <!-- workspace:id=work:9cb02c59-e111-5d77-a17c-75bedcd4b84b --> `archway` voussoir colliders are the AABB of a rotated wedge, so the
      corners of each box stand outside the block: 0.16 m in plan, 1.11 m of
      roofGap on the crown box. Deliberate (the alternative is a staircase
      collider on a ledge players mantle), but it is the last entry over 25 cm
      on a SOLID surface and it should be either narrowed or written into
      `docs/geometry-unlock.md` as a sanctioned exception.

## Next — performance

Measured 2026-07-26 with `tools/perfprobe.mjs`, `tools/perfinv.mjs` and
`tools/hitch.mjs` on an RTX 5070 Ti. Read `docs/perf.md` before opening any of
these — it records what the numbers were, and, more usefully, which two
plausible fixes were built, measured, and thrown away.

- [x] <!-- workspace:id=work:07f88a74-6d0a-56ba-a1a4-89efbdecb14b --> 2026-07-26: **Make the contact-shadow march cost less than 40% of the
      frame.** Done as far as the measurements allow, and the answer is that
      there is no free version of it. Half-resolution is worth 16–37% of the
      whole frame on every shot on both themes, and it is what `balanced` and
      `lite` turn on. Fewer steps/taps (10/6/4) and skipping both bilateral
      blur passes were BOTH measured free — the pass is bound by its pixel
      count and its dependent texture fetches, not by arithmetic or by the
      blur — so neither is a lever and no level turns them. Numbers, and the
      honest account of what half resolution costs to look at, are in
      `docs/lite-mode.md`. Not promoted to the default; see the item below.
- [x] <!-- workspace:id=work:f94b4967-092f-58a8-9df6-b9077af15d37 --> 2026-07-26: **Decide the pixel-ratio cap deliberately.** It is now a
      quality-level knob rather than a literal — `high` keeps the shipped cap
      of 2, `balanced` 1.5, `lite` 1 (`src/render/quality.js`, applied in
      `src/main.js`). It remains a taste call, and it is now Ethan's to make by
      picking a level rather than an agent's to make by editing a constant.
      Note the harness cannot measure it: headless Chromium runs at dpr 1, so
      its size comes from the `halfres` ablation instead.
- [ ] <!-- workspace:id=work:4969848d-b094-5d0d-840a-3c0457826252 --> Re-measure on hardware that is not a 5070 Ti before concluding anything
      about geometry. Every "the world is too many triangles" hypothesis died
      against this GPU (see `docs/perf.md`); none of them has been tested on an
      integrated part, where vertex throughput is a real constraint.

## Next — feel and content

- [x] <!-- workspace:id=work:13ca7631-ada5-532d-a9e7-70b5a2f19dc4 --> <!-- closed 2026-08-12: landed — src/theme.js imports VOID_AUDIO and sets audio: VOID_AUDIO, exactly the two lines the item asked for. Residue: the dead fallback in src/audio.js:537 can be deleted opportunistically --> **Wire `audio: VOID_AUDIO` into `src/theme.js`.** The void's soundscape
      is a theme overlay of exactly the shape `grade`/`exposure`/`aerial`
      already use, and it currently reaches the engine through a named fallback
      in `Audio._resolveTheme` (`theme.name === 'void'`) because `theme.js`
      belongs to another lane. Two lines close it — `import { VOID_AUDIO } from
      './audio/void.js'` and `audio: VOID_AUDIO` in the void block — after
      which the fallback branch is dead and can go. Nothing audible changes:
      `theme.audio` is already preferred whenever it exists, and
      `node tools/voidaudio.mjs` proves it either way.
- [ ] <!-- workspace:id=work:4182bc9f-e850-5feb-91b7-6b5ef1bb711b --> The beam hum is mono. `Audio.update` is handed the player but not the
      camera yaw, so a landmark can say "near" and not "which way" — a
      StereoPannerNode fed from `rig.yaw` would make the beams navigable in the
      dark rather than merely present. Needs one extra argument at the
      `audio.update` call site in `main.js`.
- [ ] <!-- workspace:id=work:0254ffc5-62de-5355-a796-65fc633db9fc --> Hands-on playtest by Ethan — the acceptance gate for movement feel.
- [ ] <!-- workspace:id=work:1b3f1b50-9b93-5060-8009-5cb1aa28481b --> Audio pass: current cues are placeholder-grade. Adopt the reference's
      `transient + body + texture + debris` layering, round-robin timbre
      variants per event, and a 9-ray space probe driving reverb blend.
      (The layering, the round-robins, the probe and the surface profiles are
      all in `src/audio.js` now; what is left under this item is a pass with
      ears on the archipelago's own cue set.)
- [ ] <!-- workspace:id=work:295424e4-ed53-59ee-8839-b668aef8ff28 --> Crystals have no voice. `src/crystals.js` places ~300 shards through the
      void course and `CrystalField.emitters()` already ranks the brightest,
      but nothing in `src/audio.js` reads them — the beams got a proximity hum
      and the crystals did not. Same mechanism, a much higher and sparser
      voice, and it would give the mid-course landmarks the readability the
      beams have.
- [ ] <!-- workspace:id=work:75c24d6a-aefb-5fe7-a5c8-3fc860e87e91 --> Visible courier hands with spring-driven lag and a grapple-cuff
      silhouette — the fiction already calls for them.
- [ ] <!-- workspace:id=work:c3a075c0-03b3-57db-9fb4-01d7d19d4ebc --> Extend the course past the current opening leg to a full 3–5 minute route.
- [ ] <!-- workspace:id=work:73d46210-f7f2-5915-825c-10e5789c64eb --> Best-time persistence per checkpoint split (localStorage).
- [x] <!-- workspace:id=work:559400af-fe8f-58d3-a88b-89a712a6e72b --> <!-- closed 2026-08-12: superseded — games/skyline-courier is registered in workspace.json (status active, remote set) --> Register the repo in `workspace.json` (manifest change needs its own lane).
- [ ] <!-- workspace:id=work:6b4885f7-a66d-55c0-9e19-a8248d58b3d2 --> HUD: render the grapple release reason. `Player.lastRelease`
      (`{reason, arrived, speed, dist, fireDist, held}`) and the cumulative
      `Player.releaseTally` are populated and shipped; nothing draws them yet.
      Ethan asked to *see* why a line disconnects, and `src/hud.js` belongs to
      another lane. Suggested: a one-word tag by the HOOK lamp that persists
      about a second after release, dimmed for `arrived` (the payoff) and
      picked out for `expired` / `landed` (the two that cost you the crossing).
- [ ] <!-- workspace:id=work:aebb3283-b259-584f-af26-a7e452a065b0 --> Audio: distinguish the release reasons. `src/audio.js` currently maps the
      whole `grapplerelease` event to one cue; the event now carries `reason`,
      so an arrival and a line that simply ran out can stop sounding identical.
- [ ] <!-- workspace:id=work:09d8a41d-643c-5769-90eb-8750c61059f6 --> Add a per-shot regression gate to `tools/shotset.mjs` — assert p1, clipped
      high/low and `regionSpread` against per-shot budgets so a grade change
      that lifts the blacks again fails the harness instead of shipping. The
      harness measures all of this already and asserts none of it.

## Later — capability probe (Ethan 2026-07-25: "3 later")

Does not start until the playable slice is accepted.

- [ ] <!-- workspace:id=work:1e8c8d2f-5ed0-5c6c-9fbf-dc4d55bf72c5 --> Generalise `tools/containment.mjs` past the underpass and wire it into
      `tools/ship-gate.sh`. It currently probes one flank because that is where
      the bug was found, but the class it catches — a barrier whose ornament is
      `L.mesh` and whose collider therefore has a hole a sliding capsule fits
      through — is a whole-course risk, and nothing else in the harness looks
      for it. A probe nobody runs rots.
- [ ] <!-- workspace:id=work:bb5bdc4e-4844-54fc-ac4e-bb9405fa0b81 --> Custom render pipeline: HDR targets, cascaded shadows, TAA, bloom pyramid.
- [ ] <!-- workspace:id=work:f747e826-af9a-5596-844b-635735e33ca6 --> BVH broadphase over a triangle soup, replacing the AABB-only collider.
- [ ] <!-- workspace:id=work:2721b505-187d-5bed-aa5b-7a94a5fa4d06 --> Full Web Audio spatialisation: HRTF panning, occlusion raycasts, IR reverb.

## Done

- [x] <!-- workspace:id=work:7bf9cd09-ff26-55a6-aad5-c227cad8eb4f --> 2026-07-25: **Macro-noise normal tilt and world-planar projection.** The
      shading normal is perturbed by the gradient of a low-frequency noise field
      (`src/materials/shader.js`, macro relief), and the tile frame projects
      onto the ground plane on up-faces and onto (along-wall, height) elsewhere.
      For an axis-aligned box world that is triplanar in everything but name, so
      the roadmap's "triplanar" item is closed by it; a true three-axis blend
      only earns its cost if rotated meshes ever arrive.
- [x] <!-- workspace:id=work:3cd6f5e6-d778-51ed-8f8a-c6a09c2908cf --> 2026-07-25: **Two-band macro albedo/roughness variation**, 1–4 m and
      8–16 m, both live in `MAIN_FRAGMENT`. The large band is the only macro
      detail that survives to distance and it does.
- [x] <!-- workspace:id=work:77777858-6d73-57f8-b0b7-d694e4880b61 --> 2026-07-25: **Screen-space contact shadows** — `src/render/contact.js`,
      depth + view-normal target, AO radius 0.9 m, screen clamp 0.10 uv. It is
      in the frame and firing. It is also tuned entirely for broad occlusion and
      does nothing at a 90° interior junction, which is why a short-radius tap
      set is open above.
- [x] <!-- workspace:id=work:9f1fab54-5483-5cbb-afde-e69f6dc2da24 --> 2026-07-25: **Analytic sunset sky IBL through PMREM** —
      `src/render/skyenv.js`, regenerated only when the sun direction moves,
      replacing the flat hemisphere light.
- [x] <!-- workspace:id=work:328f68cc-4e01-567f-b97c-cdd3a73f1fdb --> 2026-07-25: **Stochastic de-tiling with a height-preserving blend**
      (`scHeightBlend`, luminance-weighted so contrast does not collapse).
      Enabled on moss (0.95) and stone (0.9); ashlar, brass and terracotta keep
      registered detail keyed to their box and opt out on purpose.
- [x] <!-- workspace:id=work:65d32fbc-075a-5b0a-a13b-643063acd813 --> 2026-07-25: **Wall/ground moss creep wedge in the shader** — a 25–40 cm
      gradient driven by height above up to four registered floor planes. The
      shader term exists and is correct; its on-screen read at a wall base is
      still too weak to see, so the geometry-side `mossWedge` primitive stays
      open above.
- [x] <!-- workspace:id=work:7630bd76-34a5-5849-9e1c-eb286348c274 --> 2026-07-25: **The architecture kit is actually placed.** 15.6k → ~986k
      triangles at ~43 draw calls: columns with base/shaft/capital, entablature
      and cornice, balustrades, lantern brackets, arches, gear wheels, cypress
      stands, viaducts, `massif()` for carved three-course masses. `level.js`
      now asserts every kit prefab is placed, because a kit nobody imports is
      exactly how this course once shipped with arches that existed only in
      source.
- [x] <!-- workspace:id=work:7b7eeaf9-ef8a-5aaf-97f6-ecfbd292faeb --> 2026-07-25: **Headless screenshot + frame-time harness** —
      `tools/shotset.mjs` captures 8 named gameplay poses in one launch and
      analyses each (luminance, saturation, percentiles, region spread, clipping,
      draws, triangles, ms/frame), failing on a uniform frame or a console
      error. Promoted out of "Later" because nothing in this push could be
      judged without it. Frame cost across the set is 2.9–5.4 ms.
- [x] <!-- workspace:id=work:d974a3ad-5be1-59e6-8260-a87a4e262972 --> 2026-07-25: **Movement bugs found by measurement.** Ground friction was
      removing 178 m/s² at dash speed; the eye teleported ~0.8 m entering and
      leaving a slide; head-bob ran at 2.6 Hz over footsteps at 4.3 Hz. Then air
      control: steering is now a magnitude-preserving rotation separate from
      Quake `accelerate()` (75.8° in half a second at sprint, versus effectively
      nothing before), and the air jump blends heading halfway instead of
      assigning full speed to the new direction (52.9° rather than a right-angle
      catapult). One second of hard alternating air input gains 0.15 m/s, so
      steering did not become a speed exploit.
- [x] <!-- workspace:id=work:c221ad27-1b95-524d-819f-80e11900e5ea --> 2026-07-25: **Z-fighting fix** — 52 coplanar overlaps down to 6, none of
      them cross-material, which is what caused the ground flicker.
- [x] <!-- workspace:id=work:156cb942-c156-57f4-96c3-454716d2c25e --> 2026-07-25: Scaffolded the repo — Vite 7 + Three.js r180, workspace docs
      pattern, and the purpose/intent/taste briefs carried over from the parked
      Clockwork Garden.

## Playtest 2026-07-25 (live build 78603ac) — Ethan

Verbatim, so nothing gets softened in paraphrase.

**Praised, do not change:** the compass top-right, the km/h readout bottom-left,
the new timer treatment. *"the rest looks really great."*

- [ ] <!-- workspace:id=work:fb505f67-7161-5b60-93eb-2473b2165a22 --> **"Invisible glass"** — STILL OPEN. Soft translucent panels overlay the
      brass wall and haze the paving; clearly visible in `closeup.png`.

      **My first diagnosis was WRONG and is retracted.** I claimed A2C was
      disabled and that foliage was drawing full quads. Both were false:
      - `isEnabled(SAMPLE_ALPHA_TO_COVERAGE)` reads false only when sampled
        *outside* a draw call — `WebGLState.setMaterial` sets it per-draw.
        Hooked at the actual foliage draws it is `true`, with 4 samples.
      - Hiding foliage entirely leaves the panels **pixel-identical**. Foliage
        contributes 0.63% of the frame, all crisp silhouettes, no soft regions.

      **Ruled out by A/B (hide object, diff pixels):** foliage, goal-beacon,
      motes, grapple line/ring, wind streaks, lanterns. Hiding *every*
      non-surface effect changes 3.78% of pixels — noise. The artifact is in
      the **surface rendering itself**, not in any object.

      Also ruled out: the `L.solid(..., {hidden:true})` path double-drawing —
      `level.js` correctly skips `_emit` for hidden colliders.

      **Remaining suspects, all in `src/render/` or `src/materials*`:** most
      likely a depth disagreement between the MRT gbuffer prepass and the
      beauty pass, which would hand aerial perspective a far depth for a near
      pixel and wash it out in exactly these flat, straight-edged regions.
      Check that `mesh()`-emitted geometry is present in the prepass with the
      same transform as the beauty pass.
- [ ] <!-- workspace:id=work:8a4fc7e4-600a-5c32-9d80-6d7673951f60 --> **Foliage reads badly in places.** *"the foliage is a little weird in some
      places."* Judge from captures once the glass is gone.
- [ ] <!-- workspace:id=work:824de82e-48c1-5d1e-92ec-82bbcff88d3b --> **Stone texture is unresolved.** *"I don't even know if it's an
      improvement."* Worth a deliberate A/B rather than more iteration.
- [ ] <!-- workspace:id=work:704b550c-0bf5-5fd6-a84d-0cff3e759ad3 --> **Still cannot reach the other islands.** Third time raised. This is the
      single most repeated complaint in the project.
- [x] <!-- workspace:id=work:ba6ecc8a-a551-53ed-bd93-083bcb5ccd7f --> <!-- closed 2026-08-12: landed — the checkpoint counter is gone from the #run cluster (index.html) and hud.js notes its recolour path was removed --> **Drop the checkpoint counter** from the top-left cluster.
- [ ] <!-- workspace:id=work:6c08de69-3e34-5ccc-8e03-50f3a3ed083a --> **The hook is too strong for a straight parkour game.** *"you can
      literally just fly and because I can just fly this little parkour course
      [is] pretty boring."* Resolution is MODES, not a nerf: **FUN** keeps
      today's tuning exactly (it is why the movement feels good, and
      `docs/intent.md` records overpowered movement as a deliberate decision);
      **NORMAL** makes the grapple a traversal tool rather than flight. Both
      must keep every verb, and the "reachable without dash or grapple"
      invariant still holds in both.
- [ ] <!-- workspace:id=work:c7294b20-65d0-554a-af08-21a53d95154f --> Themes come later, and the kit must stay parameterised so a theme is a
      data change.

## Lite Mode (graphics settings)

Ethan, 2026-07-26: *"do whatever you can with minimal cost to graphics and then
add a Lite Mode for graphics in settings at a later date for the things that
will impact graphics."*

The split is deliberate and it is the right one: anything free ships silently
and by default; anything that COSTS a visible thing becomes the player's choice
rather than ours. `docs/perf.md` has the measurements that say which is which —
the renderer is fill-bound, and the contact-shadow march is 40%+ of the frame.

The plumbing and `docs/lite-mode.md` landed 2026-07-26. `src/render/quality.js`
is the one table every consumer reads; `__game.setQuality('lite')` and
`?quality=lite` both drive it; `node tools/shotset.mjs --quality lite` captures
it. What is left is the menu.

- [ ] <!-- workspace:id=work:08a335fc-6d4b-51c5-824e-a2dc0c4110c8 --> Lite Mode UI in the start menu, beside ROUTE and RULES. The plumbing is
      done — this item is the UI only, and it should be one call to
      `__game.setQuality(name)` per option. Populate the labels from
      `QUALITY_LEVELS[name].label` and `.note` rather than retyping them, so
      the menu cannot drift from the table it is describing. It must say
      honestly what each level costs visually, not just promise "better
      performance"; `docs/lite-mode.md` has the measured wording.
- [x] <!-- workspace:id=work:51567a27-1fb9-5fe3-8785-e2b2cce238a9 --> <!-- closed 2026-08-12: superseded — half-resolution contact shadows were promoted to default (src/render/quality.js 'HALF RESOLUTION, EVEN AT HIGH — promoted to default deliberately') and the newer Ethan-approved 2026-08-01 quality-tier item re-specifies the split --> **[ETHAN] Promote half-resolution contact shadows into the default?**
      Worth 16–37% of the frame on every shot on both themes, for a whole-frame
      luminance shift at or below the harness's own run-to-run noise floor
      (under 0.06%). It was left out of `high` only because this lane's
      acceptance test pinned the skyline `closeup` shot at lum 111.1 and
      half-res prints 111.0 — a rounding boundary on a 0.07/255 shift, not a
      visible change. The cost that IS real: distant thin geometry (far
      balustrades, cornice lips, foliage silhouettes) loses some of its AO
      crease; the near field is untouched. One-line change to `contactScale` in
      `src/render/quality.js`. See "What it costs to look at" in
      `docs/lite-mode.md`.
- [ ] <!-- workspace:id=work:bb5688f0-56ca-5dce-814d-b9975bfcb262 --> Decide the default. Today's look is the default and that is correct for a
      desktop GPU, but a high-DPI laptop may want Lite chosen FOR it on first
      boot — which needs a capability probe, not a guess.
- [x] <!-- workspace:id=work:609bbdb8-fc68-5100-89a7-de8f1e310659 --> 2026-07-26: `devicePixelRatio` cap belongs to Lite Mode, not to a silent
      change — it is now `pixelRatioCap` on the quality level and `high` still
      caps at 2, so nothing changed for anyone who does not pick a level. It is
      still the single largest lever available and still the one a player will
      SEE, which is exactly why it is theirs to pull.
