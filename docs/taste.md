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
