# Purpose

Prove that an agent can build a game that *feels* good, end to end, with no
external assets — every mesh, material, animation, and sound generated in code.

This is the successor to `games/clockwork-garden`, which stalled because its
bottleneck was generated-3D asset intake: a step the agent could not perform
well and could not verify without Ethan's eyes. Here the bottleneck moves into
code, where iteration is fast and a headless browser can check the result.

The test is deliberately narrow: **first-person momentum parkour**. No hero
mesh, no rig, no animation retargeting. If the movement doesn't feel good,
nothing else matters and no amount of shader work will save it.

## Success, in order

1. A 3–5 minute course that is genuinely satisfying to run, with checkpoints,
   a timer, and a finish. Movement feel is the acceptance bar.
2. A world that reads as intentional art direction, not engine primitives.
3. *(Later phase, Ethan 2026-07-25)* A capability probe — how far a from-scratch
   render pipeline, BVH physics, and synthesized audio can be pushed in a
   browser. The game is the excuse; the engine is the subject.

Phase 3 does not start until phase 1 is accepted in a hands-on playtest.

## Non-goals

- Any external asset file. Zero images, zero models, zero audio files.

  Measured 2026-08-12: three owner-approved exceptions now ship.
  `public/audio/*.ogg` (8 files, loaded by src/music.js:127),
  `public/sky/void-dome.png` (src/theme.js:360), and
  `public/tex/void-slab-top.png` (src/materials/slabdecal.js:261). Each is
  argued in CLAUDE.md rule 1. The rule still holds for everything else: no
  meshes, and every other texture is a canvas or a shader. Nothing in the build
  fails when a fourth asset is added, so this is a rule people keep, not a gate.
- A visible full-body player character. First-person is a deliberate constraint,
  not a limitation to work around later.
- A game engine or physics library. Three.js is the only runtime dependency.
