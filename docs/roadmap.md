# Roadmap

## Now — the Void (theme 2)

Acceptance is `docs/art-direction-void.md` §2, measured by
`node tools/shotset.mjs --theme void`. The sky, atmosphere, exposure and
energy beams landed 2026-07-25, and the distant scenery layer and the
six-beam rewrite landed the same day (see the changelog); what is still short
is listed here rather than in a reviewer's head.

- [x] 2026-07-25 — glowing veins and cracks through the rock. The reference's
      dark masses are threaded with magenta and violet fissures lit from
      inside, and the build had none; it was the most conspicuous single gap
      left. Added as an emissive mask in the ORM map's spare red channel,
      painted on its own fault network in `paintGlowVeins`
      (`src/materials/textures.js`), lit by `SC_VEIN` in
      `src/materials/shader.js`, and enabled only by `theme.surfaces.veins`.
      Zero extra draws, tris or texture fetches; skyline compiles none of it.
      See the changelog.
- [x] 2026-07-26 — the void was dark-on-light. The backdrop was the brightest
      thing in every frame, so all geometry read as black cutouts and `summit`
      carried a clean horizon line across it — §3's "anything that reads as a
      horizon line is wrong" and §8's named failure mode, both. The background
      came down about three stops, the light on the mass came up to meet it,
      the key was raked shallow so it lands on walls instead of floors, and the
      grade's gamut guard was all but switched off so emissives stop printing
      as white objects. `plunge` p50 52 -> 28.4, `summit` lum 79 -> 60.9, and
      all four shots now sit inside §2's `lum` and `p50` bands. See the
      changelog.
- [ ] `summit` still measures lum 60.9 against §2's 28-55 and 3.2% clipped high
      against 0.3-2.5%. Both come from the shot itself rather than the theme:
      the 26 m finish plaza fills 60% of the frame at 5 m and its rune inlay is
      an emissive at that range. §5 says "look up, not down"; the fix is either
      a recomposed `summit` in `tools/shots.mjs` or a quieter inlay intensity in
      `src/levels/void.js`, and both belong to the lanes that own those files.
- [ ] The grapple-anchor orb still blooms to near-white. `levels/void.js`
      draws it at `intensity: 2.1`, which rides far enough up AgX's log range
      that its hue is gone before any grade runs; pulling `accents.lantern`
      down to 0x5c18c0 moved it from rgb(211,204,213) to rgb(210,185,213) and
      no further. The intensity is the dial and it lives in `src/levels/void.js`.
- [ ] The fissures do not move. They are a static emissive mask, so a crack
      cannot pulse, breathe or flare as the player passes. That wants a time
      uniform driven from the frame loop, which is `render/` and `main.js`
      territory rather than a material's.
- [ ] The fissures light only themselves. Nothing near a vein is lit BY it —
      no bounce onto the rock beside it, no contribution to the crystals or
      the motes. A real answer is a cheap per-fissure point light or an
      irradiance-volume term, and both are a lighting-budget decision (§7.3)
      rather than a surface one.
- [ ] The far bands carry no light of their own. `src/fx/voidbackdrop.js` puts
      three distance bands behind the course, but every mass in them is unlit
      rock seen through haze. The reference has pinpricks out there — distant
      sigils and crystal glints — and they are most of what sells the scale.
      Wants an emissive speckle channel on the backdrop shader, kept rare
      enough that §3's "red must stay rare" still holds at a kilometre.
- [ ] Emissives in the emissive-poor shots. `tower`, `deckstrip` and
      `edgefeet` miss §2's `p99 > 215` and `clip hi 0.3-2.5%` for one reason:
      there is nothing bright in frame. This is §4.1-4.3 work — sigil rings on
      the great walls, rune inlays on platform tops, crystal clusters — not an
      atmosphere tune, and no amount of exposure will fake it.
- [ ] True black in the up-looking shots. `vista`, `underside` and `edgefeet`
      come back at `clip lo 0%` against a target of 2-8%: they contain no
      surface deep enough in shadow to reach it. Needs mass that occludes —
      §4.1's great walls — rather than a darker grade.
- [ ] `crossing` and `closeup` sit above §2's `lum` band (63 and 75 against
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

- [ ] Build a real cloud deck. `SKY_FRAG` in `src/world.js` fires the deck
      shader but produces one screen-filling blob: `t = -1.0/h` assumes the deck
      is 1 unit below the camera, and `cp = d.xz * t * 0.055` then spans ~0.2
      noise units across the whole lower screen. Use a real deck altitude
      (`t = (camY - DECK_Y) / -h`, `DECK_Y` 60–100 m below the lowest island)
      and a planar scale near 0.9–1.4 so billows are tens of metres.
- [ ] Widen the deck's value split. Shade is `uGround*0.80` against
      `mix(uGround, uSunColor, 0.42)` — under 20% apart, which is why it reads
      as a flat gradient. Take shade to ~0.55 with a cool green-blue lean and
      let the silver-lining term (`pow(sun, 6.0)`) run at 1.0+. Add a second,
      slower, larger-scale layer for silhouetted banks near the horizon.
- [ ] Sky-coupled fog. `scene.fog = FogExp2(0xffdcae, 0.0052)` is one constant
      that cannot agree with a sky running 0x5589a0 at zenith through 0xffd9a4
      at the horizon to a cloud deck below, so distant islands go cool
      blue-white against a warm tan sky and pop forward as cutouts. Sample the
      fog colour from the same sky evaluation in the view direction, or at
      minimum pitch-lerp between `uGround` and `uZenith`. Drop density to
      ~0.0030 with a height falloff so mid-distance islands survive.
- [ ] Retint aerial perspective toward the sun colour (~0xE9B57A) rather than
      toward blue-white, sun-angle dependent. Target `regionSpread` above 65 on
      `vista.png`; it is 49.9 today, the lowest of the set.

### Nothing is dark

- [ ] Put a real toe under the grade. Every shot measures 0.00% clipped low and
      p1 between 38.8 and 57.4 — dynamic range ~144/255 with no black in it.
      `GRADE.offset [0.001,0.002,0.003]` plus the AgX toe leaves a floor with
      nothing below it. Add a filmic toe (or drop slope slightly) so genuinely
      occluded geometry reaches 8–15 code values instead of 40+.
- [ ] Add a short-radius tap set (0.15–0.3 m) to `src/render/contact.js` for
      interior corners, alongside the existing broad AO radius. Acceptance:
      `tower.png` and `closeup.png` both come back with p1 < 25, and the
      wall/floor junction in `closeup.png` shows a visible darkening band.
- [ ] Model the chamfers instead of hoping AO fakes them. Give `kit.js`'s step,
      cornice and string-course helpers a 3–5 cm bevel course inset from the
      mass below, so every horizontal edge self-shadows. The balustrade already
      does this and is visibly the best-reading geometry in the set.

### The floor is green

- [ ] Split the shadow tint off display luminance. `GRADE.shadowTint`
      `[-0.026,+0.034,+0.015]` at `shadowFalloff 1.85` in `src/render/lut.js`
      greens every dark texel whether it is lit or not, and `GRADE.saturation
      1.30` amplifies it (the file's own comment measures 0.12 in / 0.69 out).
      Cut green to ~+0.018 and move the split to the lighting term in
      `src/render/patch.js`, where it can see the actual shadow/ambient ratio.
- [ ] Stop paving with `PALETTE.stone 0x8e968b` (hue 96). Its own comment in
      `src/materials.js` says it drives "a good deal of the paving"; restrict it
      to island undersides and boulder mass and pave with the sandstone albedo.
- [ ] Clamp the cool-shadow term on up-facing normals by
      `1.0 - 0.6 * max(0.0, N.y)` so treads keep their sandstone value while
      vertical faces keep the green shadow. Today the ascent stair in
      `tower.png` is a ~2.5-stop value inversion — bright risers, dark treads —
      and does not read as a stair at all.

### Brass reads as painted board

- [ ] Drive roughness from the ornament height field: ~0.18 on raised bands and
      rosette rims, 0.38–0.55 in the recessed field, so the specular breaks into
      legible shapes instead of one sheet. Plate roughness is uniform today.
- [ ] Bake a cavity/AO term from the same height field and multiply it into
      albedo at band channels and medallion undercuts at 0.55–0.65 strength.
      That is what puts dark in the crevices; there are none now.
- [ ] Add a verdigris mask — `smoothstep` on downward-facing normals plus
      low-frequency noise, tinting toward ~0x4e8f7a at ~0.35 in crevices.
- [ ] Roll the brass specular off in the AgX shoulder in
      `src/render/composite.js` so a grazing wall-run angle cannot clip the
      panel to white. `underpass.png` still clips 2.77% high; dropping
      `SURFACE.brass.glint` 1.5 → 1.15 did **not** move that number, so the
      clipping is coming from somewhere else and needs to be found first.
- [ ] Feed `src/render/skyenv.js`'s gradient into the specular so a long panel
      picks up sky at one end and sun aureole at the other.
- [ ] Give the gear and rosette ornaments real relief. The macro layer in
      `src/materials/shader.js` is documented as handling "everything ABOVE the
      size of a tile" and these fall through the gap. Either promote the hero
      rosettes to extruded geometry in `kit.js` (few, low-poly) or give the tile
      a height-derived normal, a cavity term at the tooth roots, and a parallax
      offset at grazing angles.
- [ ] Kill or commit the faint secondary ring layer on the brass — at its
      current opacity it reads as z-fighting, not as ornament.

### Every island is the same island

- [ ] `discRects()` (`src/kit.js:290`) is fully deterministic in `r` and
      `facets`, so every `drumPlatform` of a given radius is geometrically
      congruent — twelve identical silhouettes in `gaps.png`. Pass the
      platform's deterministic `rand` in and jitter each rect's `hx`/`hz` by
      ±8–12% independently, **inward only** from a nominal R so the collision
      union never grows past what the caller reserved. Vary `squash`
      (0.75–1.35), `tiers`, and the per-tier inset ratio 0.68.
- [ ] Kill the voxel undersides. The boulder lumps at `src/kit.js:449-456` are
      emitted with `{ rot: { axis: 'y', angle: a } }`, and that is the only
      rotation anywhere in `kit.js` — a Y-rotated cuboid is still a cuboid, so
      the lumps read as the same countable cubes as the tiers they were added to
      hide (`crossing.png` bottom-centre, `chain.png` centre). They are decor
      under an overhang, so they are free of the AABB collision constraint: give
      `rot` a full quaternion, tilt 12–30° on X and Z too, and add a `blob`
      primitive (bevelled box or icosahedron on a superellipsoid) with
      non-uniform per-axis scale. Leave the SOLID tier discs alone.
- [ ] Give the moss cap thickness. Extend the moss volume 10–15 cm past the
      stone drum and darken that overhang band; break the top with per-vertex
      value jitter of ±12% and hue drift across 75–105° (the vertex-colour
      channel `level.js` already uses for tint jitter is free); match the cap's
      chamfer to the drum's to kill the corner gussets visible in `gaps.png`.
      Drop overall moss value so sandstone, not moss, is the brightest surface.
- [ ] Give the moss texture a low-frequency clump mask (2–3 octaves at ~1.5 m
      and ~4 m) modulating both value (±18%) and hue (8–12° toward yellow-green
      in clumps, blue-green in hollows). Darken the outer 1.5 m toward the rim.
- [ ] Make the moss lip opaque. It is visibly translucent with a glassy sheen —
      the red cornice reads straight through it — so it looks like green film
      taped to the edge, and from above it presents as a walkable ledge. Opaque,
      vertex-displaced lower edge, outer extent inside the collider footprint,
      underside darkened hard.

### Colour discipline

- [ ] Pull `PALETTE.terracotta 0xc34a26` (`src/materials.js:64`) to something
      near 0xC0764E. At ~0.80 saturation, amplified by `GRADE.saturation 1.30`,
      it is safety-cone orange — the entire mid-mass of `underpass.png` and the
      rim of every island. The brief says "sandy peach and ochre".
- [ ] Break the rim course. `kit.js:419` emits one continuous ring at one
      radius, so each island reads as a three-layer cake: green plate, red
      stripe, grey block. Jitter each block's radius ±6% and height ±20%.
- [ ] Reserve one chroma channel for interactables. The same saturated red is a
      vault cap (a good, learnable signal, `terrace.png`) *and* the cornice of
      every scenery island the player can never touch. Add an `accent` flag to
      `solid()` in `level.js` and assert in a dev build that no `decor()` call
      uses the accent material; repaint decor cornices in desaturated ochre.
- [ ] Add per-face value variation to the terracotta slab and confirm the
      `underpass.png` overhang is actually shadow-casting — a 40 cm overhang at
      a 10° sun should lay a long dark band across the wall beneath it.

### Vegetation is missing from the architecture

- [ ] `tower.png` has an arch, two colonnades, a stair, a terrace and six blocks
      and is 100% bare stone; `terrace.png`'s floor-to-wall junctions are
      perfectly clean hard lines. `vineCurtain` exists and is only ever hung off
      island rims — hang it off colonnade architraves, arch springings and
      terrace rims too. Target: no frame contains a stone mass over ~3 m wide
      with a completely unbroken top edge.
- [ ] Add `mossWedge(edge)` as a kit primitive — a triangular-section strip
      auto-emitted at every horizontal solid/solid junction, jittered in height
      along its run. Emit as decor, below step height, so it cannot become a
      phantom surface. (The shader-side moss creep landed; the geometry did not,
      and the shader term alone is not visible at the wall bases in `closeup.png`.)
- [ ] Scatter 15–25 tuft cards and 5–8 flower clusters per island from the
      island's `rand`, under 20 cm tall so they never impersonate a ledge.

### Wayfinding

- [ ] Rebuild the goal beacon (`level.js:489 _beacon()`). It renders as a ~4 px
      uniform non-animated white stripe, barely brighter than the sky, and in
      `tower.png` the arch keystone bisects it. Wanted: a soft-edged additive
      shaft, radius and intensity pulsing ~0.4 Hz, a core well above the AgX
      knee so it survives the tone curve, a ground-flare disc at its base, and
      depth-test off after opaques so architecture never cuts it.
- [ ] Rebuild the checkpoint gate. In `terrace.png` it is a thin low-contrast
      brass wire ring at the right edge of frame, off the running line — it will
      not be seen at 47 km/h. Centre it on the run line at chest height, ~2.5 m,
      driven from `player.position`: hot brass emissive plus slow rotation
      inside 60 m, fading to a faint outline beyond.

### HUD and FX

- [ ] **The wall gauge only covers the two wall verbs.** The dash (`dashTimer`)
      and the grapple (`grappleTimer`) have exactly the property it was built
      for — a budget that runs out and then simply stops — and both currently
      end without warning. Deliberately not done in the same pass: three more
      gauges arriving at once is how an instrument panel becomes chrome, and
      the wall pair earned its place by being the thing that was actually
      reported. Decide whether the DASH and HOOK chips should drain rather than
      merely light, which would cost no new elements at all.

- [ ] The reticle is a 5 px translucent dot (`index.html:35-45`) and is
      invisible against gold and against the specular blowout. Build it from a
      2 px dark outline plus a light core; grow the `.hot` state into a 3-arc
      brass ring that closes on lock; add a screen-space anchor marker at the
      grapple target so the player aims at the world, not at a corner chip.
- [ ] Move the checkpoint toast to ~15% from the top, out of the landing read,
      with a dark scrim or a 1 px warm rule and an arrival punch. Give the
      timer, speed and chips a 1 px dark stroke — a soft shadow does nothing
      against a 220-luma sky.
- [ ] Near-fade the wind streaks. `src/fx/speed.js` `_updateStreaks` spawns at
      `ahead = 3 + rand*10` m and the camera flies through them, so a 2.8 cm
      quad passes centimetres from the lens — visible as pale bands over the
      stair treads in `tower.png` and over the moss landing in `gaps.png`.
      Multiply alpha by `smoothstep(1.2, 4.0, -mvPosition.z)`, raise the minimum
      spawn to ~6 m, and widen the angular floor from ~27° to ~40° off the
      travel axis (horizontal half-FOV is ~50°, so 27° is not peripheral).

### The void kit — what `src/voidkit.js` left open

Found while building and photographing the void ruin prefabs (see
`docs/changelog.md`, 2026-07-25). None of these are in the voidkit lane.

- [x] **The void's rock is not dark.** (2026-07-25) Repointed per theme rather
      than shaded down: `theme.surfaces.kinds` is a per-theme alias map read by
      `materials.js` `resolveKind`, and the void maps `stone` → the new
      `voidrock` painter — near-black violet riven rock, built from a fracture
      field rather than from `stone`'s domes. `surfaces.shade` is set to an
      explicit 1.0: a vertex tint can only remove value, and §3 asks for a
      violet cast, not a darker grey. See `docs/changelog.md`.
- [ ] **A hardcoded warm rim is what actually lights the void's rock.**
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
- [ ] **The void's IBL is still the golden-hour dome.** `render/skyenv.js` has
      no void mode: its peach horizon (`0xffcfa0`), gold aureole and sunlit
      cloud deck (`0xffd7a8`) are what `scene.environment` holds under
      `?theme=void`. `render/index.js` already passes `options.sky` and the
      class already has `setColors`/`setGains`; the void descriptor's `sky`
      block does not reach it. Measured as second-order for now rather than as
      a cause: dropping both void surfaces' `envMapIntensity` from 0.85 to 0.12
      produced a bit-identical frame, so the warm dome is not what is currently
      lighting the rock. It becomes the largest remaining ambient term the
      moment the rim above is fixed.
- [ ] **The void still draws a cloud sea and a warm horizon band.**
      `world.js`'s cloud deck renders under the void theme, giving exactly the
      readable horizon line §3 says is wrong ("there is no sun and no sky").
      Visible in every frame of `docs/captures/voidkit/`.
- [ ] **The wall-run face goes unreadable under the void's key light.** The
      panel grooves and their 7.5 cm arrises read clearly under `?theme=skyline`
      and nearly vanish at `keyIntensity: 0.35` with no crystal in the scene.
      Geometry is doing what §6 asks; the light is not reaching it. Likely
      answers are crystal fill near the run band or a bounce term, not more
      relief — more relief would break the flat run plane.
- [ ] **`voidkit` prefabs are not in a course.** They are exercised only by the
      scratch stage, so they have never been judged from the gameplay camera on
      a real route, and `trackedVoidKit().assertAllPlaced()` guards nothing yet.
      Wire them into the void course and fold `tools/voidshots.mjs` into the
      ship gate, or delete the stage.

### Far LOD

- [ ] Replace the box-on-a-disc impostor with a silhouette carrying a moss cap,
      a tapering underside and one vertical brass or cypress accent. Silhouette
      variety is what makes an archipelago read, and at that range it is nearly
      free.

### Hidden colliders that still overhang their mesh

Audited numerically by `node tools/hollow.mjs`, which walks every hidden
collider in the real course and measures how far its boundary is from the
nearest drawn triangle. The big ones are fixed; these two are measured, judged
minor, and left on purpose rather than missed.

- [ ] `drumPlatform` boulder tiers (`kit.js`, the `disc(S, ..., tr, h, ...)`
      inside the tier loop): the `blob()` drawn inside a tier reaches its
      collider's across-flats radius only where the noise happens to peak, so
      the tier collider stands up to **4.06 m** outside the drawn rock on 17 of
      268 solid islands. It cannot be seen through — the collider is never
      drawn — but it is an invisible ledge a falling player can land on. Fix by
      sizing the tier collider from the blob's MEASURED silhouette rather than
      from its worst-case bound, and re-run `tools/hollow.mjs`.
- [ ] `archway` voussoir colliders are the AABB of a rotated wedge, so the
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

- [ ] **Make the contact-shadow march cost less than 40% of the frame.**
      `src/render/contact.js` is a 14-step screen-space ray march plus an
      8-sample AO spiral at FULL resolution, and turning it off is worth
      2.2–2.4 ms of a 4.4–5.5 ms frame at 1440p — the largest single item in
      the renderer by a wide margin, on both themes. It is also the item that
      scales worst with resolution, which is what makes it the thing a player
      on a 4K panel feels. Half-resolution march with a bilateral upsample, or
      fewer steps at distance, are the obvious moves; both are visual changes
      and need a shot-set diff.
- [ ] **Decide the pixel-ratio cap deliberately.** `src/main.js` uses
      `Math.min(window.devicePixelRatio, 2)`, so a HiDPI display quietly asks
      for up to 4x the fragments of the window it is drawn in. The frame is
      fill-bound, so that multiplier lands directly on frame time.
      `RenderPipeline` already carries a `renderScale` option that nothing
      sets. This is a TASTE call, not a technical one — it trades sharpness
      for frame rate — so it needs Ethan, not an agent.
- [ ] Re-measure on hardware that is not a 5070 Ti before concluding anything
      about geometry. Every "the world is too many triangles" hypothesis died
      against this GPU (see `docs/perf.md`); none of them has been tested on an
      integrated part, where vertex throughput is a real constraint.

## Next — feel and content

- [ ] **Wire `audio: VOID_AUDIO` into `src/theme.js`.** The void's soundscape
      is a theme overlay of exactly the shape `grade`/`exposure`/`aerial`
      already use, and it currently reaches the engine through a named fallback
      in `Audio._resolveTheme` (`theme.name === 'void'`) because `theme.js`
      belongs to another lane. Two lines close it — `import { VOID_AUDIO } from
      './audio/void.js'` and `audio: VOID_AUDIO` in the void block — after
      which the fallback branch is dead and can go. Nothing audible changes:
      `theme.audio` is already preferred whenever it exists, and
      `node tools/voidaudio.mjs` proves it either way.
- [ ] The beam hum is mono. `Audio.update` is handed the player but not the
      camera yaw, so a landmark can say "near" and not "which way" — a
      StereoPannerNode fed from `rig.yaw` would make the beams navigable in the
      dark rather than merely present. Needs one extra argument at the
      `audio.update` call site in `main.js`.
- [ ] Hands-on playtest by Ethan — the acceptance gate for movement feel.
- [ ] Audio pass: current cues are placeholder-grade. Adopt the reference's
      `transient + body + texture + debris` layering, round-robin timbre
      variants per event, and a 9-ray space probe driving reverb blend.
      (The layering, the round-robins, the probe and the surface profiles are
      all in `src/audio.js` now; what is left under this item is a pass with
      ears on the archipelago's own cue set.)
- [ ] Crystals have no voice. `src/crystals.js` places ~300 shards through the
      void course and `CrystalField.emitters()` already ranks the brightest,
      but nothing in `src/audio.js` reads them — the beams got a proximity hum
      and the crystals did not. Same mechanism, a much higher and sparser
      voice, and it would give the mid-course landmarks the readability the
      beams have.
- [ ] Visible courier hands with spring-driven lag and a grapple-cuff
      silhouette — the fiction already calls for them.
- [ ] Extend the course past the current opening leg to a full 3–5 minute route.
- [ ] Best-time persistence per checkpoint split (localStorage).
- [ ] Register the repo in `workspace.json` (manifest change needs its own lane).
- [ ] HUD: render the grapple release reason. `Player.lastRelease`
      (`{reason, arrived, speed, dist, fireDist, held}`) and the cumulative
      `Player.releaseTally` are populated and shipped; nothing draws them yet.
      Ethan asked to *see* why a line disconnects, and `src/hud.js` belongs to
      another lane. Suggested: a one-word tag by the HOOK lamp that persists
      about a second after release, dimmed for `arrived` (the payoff) and
      picked out for `expired` / `landed` (the two that cost you the crossing).
- [ ] Audio: distinguish the release reasons. `src/audio.js` currently maps the
      whole `grapplerelease` event to one cue; the event now carries `reason`,
      so an arrival and a line that simply ran out can stop sounding identical.
- [ ] Add a per-shot regression gate to `tools/shotset.mjs` — assert p1, clipped
      high/low and `regionSpread` against per-shot budgets so a grade change
      that lifts the blacks again fails the harness instead of shipping. The
      harness measures all of this already and asserts none of it.

## Later — capability probe (Ethan 2026-07-25: "3 later")

Does not start until the playable slice is accepted.

- [ ] Generalise `tools/containment.mjs` past the underpass and wire it into
      `tools/ship-gate.sh`. It currently probes one flank because that is where
      the bug was found, but the class it catches — a barrier whose ornament is
      `L.mesh` and whose collider therefore has a hole a sliding capsule fits
      through — is a whole-course risk, and nothing else in the harness looks
      for it. A probe nobody runs rots.
- [ ] Custom render pipeline: HDR targets, cascaded shadows, TAA, bloom pyramid.
- [ ] BVH broadphase over a triangle soup, replacing the AABB-only collider.
- [ ] Full Web Audio spatialisation: HRTF panning, occlusion raycasts, IR reverb.

## Done

- [x] 2026-07-25: **Macro-noise normal tilt and world-planar projection.** The
      shading normal is perturbed by the gradient of a low-frequency noise field
      (`src/materials/shader.js`, macro relief), and the tile frame projects
      onto the ground plane on up-faces and onto (along-wall, height) elsewhere.
      For an axis-aligned box world that is triplanar in everything but name, so
      the roadmap's "triplanar" item is closed by it; a true three-axis blend
      only earns its cost if rotated meshes ever arrive.
- [x] 2026-07-25: **Two-band macro albedo/roughness variation**, 1–4 m and
      8–16 m, both live in `MAIN_FRAGMENT`. The large band is the only macro
      detail that survives to distance and it does.
- [x] 2026-07-25: **Screen-space contact shadows** — `src/render/contact.js`,
      depth + view-normal target, AO radius 0.9 m, screen clamp 0.10 uv. It is
      in the frame and firing. It is also tuned entirely for broad occlusion and
      does nothing at a 90° interior junction, which is why a short-radius tap
      set is open above.
- [x] 2026-07-25: **Analytic sunset sky IBL through PMREM** —
      `src/render/skyenv.js`, regenerated only when the sun direction moves,
      replacing the flat hemisphere light.
- [x] 2026-07-25: **Stochastic de-tiling with a height-preserving blend**
      (`scHeightBlend`, luminance-weighted so contrast does not collapse).
      Enabled on moss (0.95) and stone (0.9); ashlar, brass and terracotta keep
      registered detail keyed to their box and opt out on purpose.
- [x] 2026-07-25: **Wall/ground moss creep wedge in the shader** — a 25–40 cm
      gradient driven by height above up to four registered floor planes. The
      shader term exists and is correct; its on-screen read at a wall base is
      still too weak to see, so the geometry-side `mossWedge` primitive stays
      open above.
- [x] 2026-07-25: **The architecture kit is actually placed.** 15.6k → ~986k
      triangles at ~43 draw calls: columns with base/shaft/capital, entablature
      and cornice, balustrades, lantern brackets, arches, gear wheels, cypress
      stands, viaducts, `massif()` for carved three-course masses. `level.js`
      now asserts every kit prefab is placed, because a kit nobody imports is
      exactly how this course once shipped with arches that existed only in
      source.
- [x] 2026-07-25: **Headless screenshot + frame-time harness** —
      `tools/shotset.mjs` captures 8 named gameplay poses in one launch and
      analyses each (luminance, saturation, percentiles, region spread, clipping,
      draws, triangles, ms/frame), failing on a uniform frame or a console
      error. Promoted out of "Later" because nothing in this push could be
      judged without it. Frame cost across the set is 2.9–5.4 ms.
- [x] 2026-07-25: **Movement bugs found by measurement.** Ground friction was
      removing 178 m/s² at dash speed; the eye teleported ~0.8 m entering and
      leaving a slide; head-bob ran at 2.6 Hz over footsteps at 4.3 Hz. Then air
      control: steering is now a magnitude-preserving rotation separate from
      Quake `accelerate()` (75.8° in half a second at sprint, versus effectively
      nothing before), and the air jump blends heading halfway instead of
      assigning full speed to the new direction (52.9° rather than a right-angle
      catapult). One second of hard alternating air input gains 0.15 m/s, so
      steering did not become a speed exploit.
- [x] 2026-07-25: **Z-fighting fix** — 52 coplanar overlaps down to 6, none of
      them cross-material, which is what caused the ground flicker.
- [x] 2026-07-25: Scaffolded the repo — Vite 7 + Three.js r180, workspace docs
      pattern, and the purpose/intent/taste briefs carried over from the parked
      Clockwork Garden.

## Playtest 2026-07-25 (live build 78603ac) — Ethan

Verbatim, so nothing gets softened in paraphrase.

**Praised, do not change:** the compass top-right, the km/h readout bottom-left,
the new timer treatment. *"the rest looks really great."*

- [ ] **"Invisible glass"** — STILL OPEN. Soft translucent panels overlay the
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
- [ ] **Foliage reads badly in places.** *"the foliage is a little weird in some
      places."* Judge from captures once the glass is gone.
- [ ] **Stone texture is unresolved.** *"I don't even know if it's an
      improvement."* Worth a deliberate A/B rather than more iteration.
- [ ] **Still cannot reach the other islands.** Third time raised. This is the
      single most repeated complaint in the project.
- [ ] **Drop the checkpoint counter** from the top-left cluster.
- [ ] **The hook is too strong for a straight parkour game.** *"you can
      literally just fly and because I can just fly this little parkour course
      [is] pretty boring."* Resolution is MODES, not a nerf: **FUN** keeps
      today's tuning exactly (it is why the movement feels good, and
      `docs/intent.md` records overpowered movement as a deliberate decision);
      **NORMAL** makes the grapple a traversal tool rather than flight. Both
      must keep every verb, and the "reachable without dash or grapple"
      invariant still holds in both.
- [ ] Themes come later, and the kit must stay parameterised so a theme is a
      data change.

## Lite Mode (graphics settings)

Ethan, 2026-07-26: *"do whatever you can with minimal cost to graphics and then
add a Lite Mode for graphics in settings at a later date for the things that
will impact graphics."*

The split is deliberate and it is the right one: anything free ships silently
and by default; anything that COSTS a visible thing becomes the player's choice
rather than ours. `docs/perf.md` has the measurements that say which is which —
the renderer is fill-bound, and the contact-shadow march is 40%+ of the frame.

- [ ] Lite Mode UI in the start menu, beside ROUTE and RULES. Plumbing and
      `docs/lite-mode.md` land first (separate lane); this item is the UI only.
      It must say honestly what each level costs visually, not just promise
      "better performance".
- [ ] Decide the default. Today's look is the default and that is correct for a
      desktop GPU, but a high-DPI laptop may want Lite chosen FOR it on first
      boot — which needs a capability probe, not a guess.
- [ ] `devicePixelRatio` cap (`src/main.js:51`, currently `min(dpr, 2)`) belongs
      to Lite Mode, not to a silent change. On a 4K panel it is 4x the pixels
      and the single largest lever available; it is also the one a player will
      SEE, which is exactly why it is theirs to pull.
