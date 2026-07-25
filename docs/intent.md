# Intent

## The fiction

You are a **wind-up courier** — the same clockwork world as the parked
`games/clockwork-garden`, seen from inside the goggles instead of over the
shoulder. Deliveries cross a city of brass-and-porcelain towers and floating
garden terraces. You are always late. The route is never the safe way.

First-person is in-fiction, not just a technical dodge: you see your own
gloved hands, the brass grapple cuff on your wrist, and nothing else.

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
- `src/audio.js` — Web Audio synthesis. No files, ever.

The hard separation that matters: **level geometry and level collision are
generated from one source**. Clockwork Garden's recurring bug was a visible
thing that wasn't solid and a solid thing that wasn't visible.
