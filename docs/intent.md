# Intent

## The fiction

You are a **wind-up courier** — the same clockwork world as the parked
`games/clockwork-garden`, seen from inside the goggles instead of over the
shoulder. Deliveries cross a city of brass-and-porcelain towers and floating
garden terraces. You are always late. The route is never the safe way.

First-person is in-fiction, not just a technical dodge: you see your own
gloved hands, the brass grapple cuff on your wrist, and nothing else.

## The feel target (Ethan, 2026-07-25)

**Dying Light 2, Mirror's Edge Catalyst, and first-person Forspoken.** What
those three share, and what this game is aiming at:

- **Traversal is effortless, not fussy.** Vaults, mantles and ledge catches
  happen automatically and generously. The player expresses skill through
  *route choice and speed*, not through frame-perfect inputs. Every assist
  window here is deliberately wider than it needs to be.
- **Mistakes are recoverable.** A double jump, an air dash, and a forgiving
  ledge grab mean a misjudged gap is survivable. That is what lets a player
  commit to a fast line instead of creeping.
- **Abilities sit on top of the base verbs**, they do not replace them. Dash
  and the vertical wall-run extend the vocabulary; they never become the only
  way through.
- **Speed is communicated like a racing game** — peripheral streaks, a
  tightening vignette, FOV, camera shake, wind rushing past. All peripheral by
  construction, because the centre of the screen is where the player reads the
  ledge they are about to land on.

## The movement is deliberately overpowered (Ethan, 2026-07-25)

*"honestly they are so fun I want to keep them like that and just improve
graphics and expand course."*

Dash and grapple make the player far more mobile than a traditional parkour
game would allow, and that is the point. The design response to "this trivialises
the course" is **build a bigger course**, never "reduce the ability."

Concretely, this means:
- Do not nerf `dashSpeed`, `grappleRange`, `airJumps`, or the wall-run carry to
  restore difficulty to an existing obstacle. Move the obstacle.
- Difficulty comes from *distance, height, and route choice*, not from fighting
  the controller.
- The traversal envelope these abilities create is documented with real numbers
  in [`course-design.md`](course-design.md). Build against that table.

## The movement vocabulary

The whole game is these verbs and how cleanly they chain:

| Verb | Input | Rule |
|---|---|---|
| Run | WASD | High ground accel, real friction, no instant stop |
| Sprint | Shift | Raises the speed cap; feeds FOV and step rhythm |
| Jump | Space | Coyote time + input buffering; never eat a jump |
| Wall-run | Approach a wall airborne, with speed | Gravity heavily damped, camera rolls, has a timer |
| Wall-jump | Space while wall-running | Kicks off along the wall, preserves forward speed |
| Slide | Ctrl while fast | Low friction, lowers the capsule, gains speed downhill |
| Vault | Run into a low ledge | Automatic mantle, keeps momentum through the top |

The design question every addition answers: *does this let a good player carry
more speed than a bad one?* If not, it's decoration.

## Architecture intent

- `src/collision.js` — the only thing that knows about geometry. Swept capsule
  against a static box set. Deliberately AABB-only: wall-running and vaulting
  need collision that is *predictable* far more than it needs to be general.
- `src/player.js` — a state machine over the collision result. Owns momentum.
- `src/camera.js` — springs and damping only. Reads player state, never writes.
- `src/level.js` — the course, as data. Geometry and collision come from the
  same declarations, so a visible surface is always a solid one.
- `src/audio.js` — sound effects, Web Audio synthesis. No files, ever.
- `src/music.js` — the one asset exception: generated looping tracks under
  `public/audio/`. See CLAUDE.md for why music is carved out and art is not.

The hard separation that matters: **level geometry and level collision are
generated from one source**. Clockwork Garden's recurring bug was a visible
thing that wasn't solid and a solid thing that wasn't visible.

## 2026-07-27 — Ethan's answers, after playing the deployed build

**Performance target is SMOOTHNESS, not a number.** Asked whether "240fps"
meant 1080p/1440p/4K native, he answered: *"I care about smoothness, not the
number."* So the metric for every future perf claim is **frame-time
consistency** — p99 frame time, hitch count, 1% lows — not mean fps. A build
with a lower average and no stutter beats a higher average that spikes. Mean
ms/f alone is no longer a sufficient receipt.

**Lite is allowed to look worse.** *"Yes — Lite may visibly drop contact
shadows."* Confirms `contactShadows: false` for Lite. High stays byte-identical
to the shipped reference; that invariant is unchanged. A performance setting
that costs nothing visually was the placebo we just removed.

**Scope from here: perf, then polish, then done.** *"perf improvements then
polish what exists and call it done."* The course-length gap (755 m measured
against the 900–1400 m target in `docs/course-design.md`) and the unbuilt
sub-zero descent are therefore **explicitly not being closed** — that spec
target is retired rather than outstanding. No new course content, no new
mechanics. Finish the frame work, polish what is here, stop.
