# Art direction — THEME 2: the Void

The second theme. Read `docs/art-direction.md` first for the house rules; this
document overrides its palette and light, not its principles.

## THE REFERENCE IMAGE IS `docs/reference/theme2-void.png`

**LOOK AT IT.** Read that file before you read another word of this document,
and look at it again before you judge any frame you have rendered. It is the
target. This document is commentary ON it — measurements, palette anchors and
acceptance numbers taken off that image — and commentary is a lossy copy.

It lives in the repo deliberately. CLAUDE.md rule 1 bans art assets THE GAME
LOADS; it does not ban documents the team reads, and this one is never
imported, never bundled and never seen by `vite build`. (I got that wrong once
and wrote this document as a substitute for the file. Ethan: *"NOooooo it has
to reference the exact file. Who bans image files? I dont."*)

Written from that image, 2026-07-25. Where a number appears below it was read
off the image rather than invented.

Ethan's brief, verbatim on the parts that bind:

> "a huge dark mythical void filled with floating ruins, glowing jagged
> crystals, purple, blue, and red energy, fog, particles, and many platforms
> rising high into the sky. The level should feel vertical, fast, mysterious,
> futuristic, and slightly magical, with the player almost flying upward."

---

## 0. THIS IS A NEW LEVEL, NOT A REPAINT

Ethan, 2026-07-25, after being shown the existing course rendered in violet:

> "I like that you did colors different, but that's not going to be the theme.
> The theme is a totally different map with totally new sprites, totally new
> everything to match the screen. It's like a totally different level."

Binding, and it overrides any reading of `docs/scaling-plan.md` that treats a
theme as a palette swap. The deliverable is a **second level**: its own course,
its own geometry, its own prefabs, its own layout. The sunset archipelago
recoloured violet is explicitly NOT it.

What the theme descriptor in `src/theme.js` is actually for: it carries the
light, fog, grade and exposure so the new level is lit correctly from the first
frame. It is plumbing under the level, not the level. Do not mistake a passing
value-structure table (§2) for a finished theme — those numbers only say the
LIGHTING is right.

The work is, in order: **new prefabs** (crystals, great walls, rune slabs,
sigils, beams) → **a new vertical course built from them** → the lighting that
already exists → the harsh review loop. Effort should follow that order.

## 0b. THE VOID IS BUILT FOR THE FULL MOVEMENT SET

Ethan, 2026-07-25, after running the first scaffold climb:

> "you're limiting yourself with how you place these. Like it's very very easy
> and you don't realize how well I can do with the grapple and the air dash. So
> I would say kind of release the constraints on yourself and you can make
> things far apart. You can make things really creative in terms of the
> placement of platforms. And then if I try it out and there's something that's
> impossible I'll tell you but I highly doubt it."

Binding, and it overrides how `docs/course-design.md`'s bands have been applied
here. The scaffold's timid 5-8 m hops came from treating "every checkpoint
reachable with no dash and no grapple" as a constraint on EVERY link. That is
not what the rule says and it produced a boring course.

What this means in practice for the void course:

- **`committed` and `grapple` links are first-class**, not last resorts. Use
  the full band table: 14-19 m committed, 20-32 m grapple-gated.
- **Spacing should be generous and varied.** Long flights, big drops, real
  distance between islands. The reference image is VAST; a course of polite
  little steps cannot look like it.
- **Place anchors deliberately** so grapple lines are part of the composition —
  §5 asks every hero vantage to be framed by a vertical, and a grapple sightline
  is a vertical the player creates.
- **The physics limits still bind.** >34 m with no anchor in range is
  impossible, not hard, and `Archipelago.verify()` still fails it. Ethan is
  relaxing the TASTE constraint, not the engine.
- **Keep a recovery line, not a safe line.** Falling must be survivable and
  re-attemptable (§6, and course-design.md on recoverability). That is a
  different and much weaker requirement than "traversable without dash".

The failure mode to avoid now is the opposite of the old one: a course so
loose it stops being readable. Readability comes from the rune-inlay language
in §6, not from short jumps.

## 1. The one-sentence read

**A near-black cathedral of carved ruins, lit entirely from within by violet
crystal and red sigil-fire, receding upward through violet fog.**

If a frame reads as "a dark version of the sunset level", it is wrong. The
sunset theme is lit BY THE SKY and shaded by mass. The void theme is lit BY
OBJECTS and shaped by darkness. That inversion is the whole brief.

---

## 2. Value structure — the thing most likely to be got wrong

The reference is a LOW-KEY image with SMALL, VERY BRIGHT accents. Most of the
frame sits in the bottom third of the value range; less than about 5% of it is
bright, and that 5% is almost all emissive.

The failure mode is a uniformly murky mid-grey frame — "dark" achieved by
turning exposure down, which flattens everything and reads as fog soup. The
correct image is a HIGH-CONTRAST one that happens to be mostly dark.

Acceptance numbers for `tools/analyze.mjs`, per shot, on the void course:

| metric | sunset (today) | void (target) | why |
| --- | --- | --- | --- |
| `lum` mean | 110–135 | **28–55** | mostly dark |
| `p1` | 14–39 | **0–6** | real crushed blacks |
| `p50` | 110–150 | **22–45** | the mass sits low |
| `p99` | 180–232 | **> 215** | emissives punch |
| `spread` (p99−p1) | 32–98 | **> 200** | the contrast is the look |
| `clip lo` | 0–0.2% | **2–8%** | true black is present |
| `clip hi` | 0–1% | **0.3–2.5%** | crystal cores blow, nothing else |
| `sat` | 0.3–0.8 | **> 0.45** | violet everywhere, never grey |

A frame that passes `lum` but fails `spread` is the murk failure. **Both must
pass.** These belong in the gate, not in a reviewer's opinion.

**WHERE THIS TABLE AND THE REFERENCE FILE DISAGREE, THE FILE WINS.** The `clip
lo` row asks for 2-8%; `theme2-void.png` itself measures 0.21%. The table is
commentary and the image is the target (see the heading at the top of this
document). Read the row as "true black must be PRESENT, not absent" rather than
as a quota — a frame driven to 5% crushed black to satisfy an arithmetic row
would be darker than the thing it is imitating.

---

## 3. Palette

Colours read off the reference. Treat as anchors, not gospel — but do not drift
toward blue-grey neutrality, which is where every "dark fantasy" scene dies.

**Rock — the mass.** Near-black, cool, faintly violet. Roughly `#14101F` in
shadow to `#2A2438` where lit. It is never a neutral grey: even the darkest
rock keeps a violet cast, and that is what stops the frame reading as
desaturated. Carved faces are a touch warmer where sigil-light lands on them.

**Violet crystal — the signature.** `#8B5CF6` body rising to `#C4A6FF` at the
edges and a near-white `#EDE4FF` core. Large shards are semi-translucent: they
transmit light along their length so the tip glows brighter than the base.
These are the biggest light sources in the frame.

**Blue crystal — the secondary.** `#3B82F6` to `#7DD3FC`. Smaller, scattered,
clustered on ruin edges and platform undersides. Reads as cooler and further
away; use it for depth, not for hero moments.

**Red / magenta energy — the punctuation.** `#FF2D55` through `#E11D48`. This
is the rarest and most intense colour and it must stay rare. It appears as:
vertical beams, glowing sigil rings on the great walls, and cracks in the rock.
If red is everywhere, the image loses its focal points.

**Fog.** Violet, `#4C3A7A` near, washing to `#6B5A9E` far. Distant structures
lose contrast and gain violet — classic aerial perspective, but toward violet
rather than toward sky-blue. This is what carries the sense of enormous depth.

**There is no sun and no sky.** The background is fog and darkness. Anything
that reads as a horizon line is wrong.

---

## 4. The elements, in priority order

Build them in this order. Each one earns the next.

### 4.1 The great walls (highest impact)

Colossal carved structures framing left and right, running the full height of
the frame and beyond it. Flat-ish faces divided into rectangular panels by deep
recessed grooves, like a machined cliff. They are what makes the space read as
built rather than as a rock field, and they are the wall-run surfaces.

On their faces: **glowing sigil rings** — concentric circles with radial tick
marks and a star or diamond at the centre, inlaid and glowing red. In the
reference the largest is several storeys across. They are the single most
memorable element after the crystals.

### 4.2 Floating ruin platforms

Dark stone slabs, roughly square, with a carved raised border and a **glowing
rune inlay on the top face** — violet, geometric, a rosette or star knot. The
top is flat and readable (it is a landing surface and must LOOK like one).

The underside is the opposite: jagged broken rock, irregular, with drip-like
spikes hanging beneath and small crystals embedded in the fracture. Nothing
about the underside is flat.

This is `drumPlatform`'s job in the sunset theme. Note that `drumPlatform` was
hollow until commit `da98a78` — reuse the FIXED prefab, and keep the invariant
it establishes: the drawn body must follow the collider's own outline.

### 4.3 Crystal shards

Two families, both **jagged and faceted, never smooth**:

- **Hero shards** — huge, violet, translucent, erupting from rock at an angle
  in clusters of three to seven at varied lengths and tilts. In the reference
  one fills the entire left edge of the frame. Big enough to be architecture.
- **Scatter shards** — small, blue or violet, in clusters on ruin edges, in
  fractures, on platform undersides. These do the work of making the world feel
  continuous rather than staged.

Facets must be flat and sharp with hard normal breaks — the whole read depends
on light snapping between faces. A smooth-shaded crystal looks like a jelly.

### 4.4 Vertical energy beams

Thin, intensely bright red/magenta columns running vertically through the void,
tens of metres long, heavily bloomed. Long, straight, and very thin — the
contrast between their thinness and their brightness is the effect.

They are also a gift to gameplay: unmissable vertical landmarks in a course
whose whole problem is that the player must read height.

### 4.5 Fog, motes and drift

Volumetric violet haze thickening with distance. Fine dust motes drifting
slowly, catching light — denser near crystals and beams. Small debris drifting
upward sells "the void has a current" and reinforces the upward pull.

---

## 5. Composition and camera

The reference is shot looking **up and forward** into a receding vertical
corridor: great walls left and right, platforms stepping away and upward toward
a bright violet vanishing point.

Rules that follow:

- **Always frame a vertical.** Every hero vantage should have a beam, a shard,
  or a wall edge running top to bottom.
- **Look up, not down.** The sunset level's beauty shots look out and across.
  These look UP. The vanishing point sits above the horizon of the frame.
- **Silhouette against glow.** Dark mass reads only when backed by something
  brighter. Every important edge needs a glow behind it — this is a composition
  rule, not a lighting one, and it must be designed into the level layout.
- **Depth in three bands.** Near mass nearly black and sharply lit; mid ruins
  in violet fog; far structures washed almost to the fog colour. If everything
  sits in one band the space collapses.

  **How the third band is built changed on 2026-07-26, and the rule did not.**
  It used to be geometry: 306 extruded prisms, then ~720 impostor cards baked
  from those same prisms. Ethan, on that build: *"honestly the random shapes in
  the background is very weak hoping the image method will improve it."* The
  diagnosis is structural — every silhouette in that layer came from one
  tapered n-gon prism, so more of them only ever bought more angular blobs. The
  third band is now `public/sky/void-dome.png`, a painted panorama tiled four
  times around the dome (CLAUDE.md rule 1's sky-dome exception), and the cards
  are deleted. Measured side by side, they drew a bed of pale faceted gravel
  ACROSS the painted architecture rather than adding to it.

  What the painting costs is parallax: it does not shift as the player climbs.
  The near band (470-600 m) and the mid band (690-850 m) are still real
  geometry and still move, so the three rungs of VALUE survive intact — what
  changed is that the furthest rung is a picture instead of a proxy.

---

## 6. Gameplay reads

The art brief and the movement brief agree here, which is lucky and should be
exploited.

- Great walls → **wall-run and wall-jump** surfaces. Their panel grooves give
  the eye something to measure speed against, which the flat brass wall in the
  sunset level does not.
- Beams → **vertical landmarks** for reading height, and natural grapple
  sightlines.
- Rune-inlaid platform tops → **landing affordance**. Continue the sunset
  level's language: a glowing rune means "you may stand here". Never put a rune
  on a surface the player cannot land on. This is load-bearing and non-negotiable
  — it is the only readability channel a dark level has.
- Crystal clusters → **hazard or handhold**, pick one and be consistent.
  Recommendation: never a hazard. Movement is sacred (CLAUDE.md rule 3) and the
  brief asks for fast and fun, not punishing.
- Fog → hides the bottom of the void, so a fall reads as bottomless without
  needing to model a bottom.

Spacing obeys `docs/course-design.md` exactly. **The traversal envelope does not
change with the theme.** A jump that works in the sunset level works here, and
one that does not is a bug in either theme.

---

## 7. Hard constraints

1. **Zero external art assets** (CLAUDE.md rule 1). Every crystal, rune and
   beam is generated geometry or a procedural canvas/shader texture. No image
   files. The music exception does not extend to anything here.
2. **Themes are a data change wherever possible** (`docs/scaling-plan.md`).
   New PREFABS are legitimate — crystals and sigils genuinely do not exist yet
   — but a new prefab must be theme-neutral in shape and take its colours from
   the theme descriptor. Nothing gets a hardcoded violet.
3. **Browser performance is a requirement, not a nice-to-have.** Instancing for
   crystals and motes, LODs on ruins, and the existing draw-call budget. A dark
   scene full of emissives is the classic way to blow a bloom budget — measure
   `ms/f` in the shot table and keep it in the range the sunset level holds.
4. **Auto-exposure must be reined in.** A near-black scene with tiny brilliant
   emissives is precisely the case that makes an auto-exposure loop hunt: it
   will try to lift the darkness and wash the whole theme out. Expect to clamp
   or bias it per theme, and treat a drifting exposure as a bug.
5. **Do not touch core movement** (Ethan, explicitly). The level adapts to the
   movement system; the movement system does not adapt to the level.

---

## 8. How this gets judged

By reading rendered PNGs from the actual gameplay camera, never by reading
code — `docs/purpose.md`'s "compiling is not verification", applied to art.

A shot passes when:

1. The measured numbers in §2 are all in range.
2. A reviewer looking at it cannot tell it apart from the reference in **value
   structure, palette and composition** — not in literal content.
3. Nothing in it reads as generic. The specific failure modes to hunt: uniform
   murk with no black point; crystals that are smooth instead of faceted; red
   used so often it stops being an accent; a visible horizon; platforms whose
   landing surface is not obviously a landing surface; and fog thick enough to
   hide the fact that nothing was built behind it.
