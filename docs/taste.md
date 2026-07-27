# Taste

Inherited wholesale from `games/clockwork-garden/docs/taste.md` — that project's
design judgement was never what failed. The rules that carry over:

- Original, compact, colorful energy. Do not copy existing game IP.
- **Palette:** cream porcelain, aged brass, moss green, warm terracotta/coral,
  restrained sky blue. Soft toybox/clay surfacing; no photoreal, no grimdark.
- Readable spaces and confident movement feedback over dense detail.
- **The parkour route is the game.** Every jump, wall-run, slide, land, and
  recovery needs immediate readable feedback before any optional scenery.
- Procedural variation must serve a coherent art direction, never novelty.
- Never trap the desktop cursor without an obvious, reliable escape route.
- Non-colliding scenery must never sit on the route, obscure the view, or
  visually impersonate a surface you can land on.
- Gameplay surfaces must read as solid, single masses — never a collage of a
  cap, a detached base, and a collision promise.
- A pass that still reads as engine primitives is a failed art pass, not a
  graphics milestone.

## Rules specific to this project

- **Momentum is the fantasy.** Any mechanic that scrubs speed without the
  player choosing to scrub speed is a bug. Landing, turning, and vaulting
  should preserve or reward speed, never silently tax it.
- **The camera is the character.** With no visible body, all physicality has to
  come through the camera — FOV under acceleration, roll into a wall-run, a
  dip on landing, weight in the step rhythm. Under-do it before over-doing it;
  motion sickness is a failure state.
- **Read the route without a tutorial.** Surfaces you can use are legible by
  color and shape alone. If a wall is runnable, it looks runnable from the
  approach, at speed, without a marker floating on it.
- **Audio is feedback, not decoration.** Footsteps, wind, and landing impacts
  are the primary confirmation that a movement state changed.
- **60fps is a design constraint, not an optimization pass.** A frame budget
  blown on scenery is a movement bug.

## The legacy skyline is the default, and that is a standard

Ethan, 2026-07-26, after A/B-ing the two looks:

> "I say we make legacy the default mode and only have the enhanced as a option
> in settings (enhanced=current). we can make the lighting a bit better for
> legacy, but keep everything else the same. then save info on the type of
> graphics legacy skyline has, thats the perfect balance of graphics where it
> looks good enough and we can iterate well."

**This will read as a downgrade in the diff. It is not.** It is a statement
about what this project's art is FOR, and it should survive anyone's instinct
to turn the settings back up.

### What the legacy look is

- **No vegetation.** No deck scatter, no rim ivy, no hero vines.
- **Box-fallback prefabs** rather than swept cornices, turned balusters and
  lathed shafts — the silhouette comes from massing, not from curves.
- Everything else identical: the palette, the golden-hour key, the HDR pipeline,
  AgX and the grade LUT, the aerial perspective, the brass instrumentation.

Measured on the same shots: **1.55 M triangles against modern's 2.2 M**, and
43-44 draws against 59-68.

### Why it is the default

Because the expensive half of the art was buying less than the cheap half.
Everything that makes a frame READ — value structure, palette, composition,
light direction, aerial perspective — is in both looks. Vegetation and curved
prefabs add fidelity per object, and cost:

- slower to render, so slower to CAPTURE, so slower to judge;
- more geometry between a change and its effect, so harder to ATTRIBUTE;
- and they are the layer most likely to hide a bug rather than reveal one —
  the hollow-platform bugs of 2026-07-25 lived under foliage for a full session.

Iteration speed is a feature of the art pipeline, not a constraint on it.

### The rule this sets

**When a detail layer costs more to iterate on than it adds to the frame, it is
an option and not the default.** Reach for light, palette and composition first;
they are cheaper, they compound, and they are what the reference images are
actually made of. `modern` is complete, supported, and one setting away —
nothing is deleted, and a player who wants the denser look gets it.
