# skyline-courier — agent brief

First-person momentum parkour in Three.js. Successor to the parked
`games/clockwork-garden`. Read `docs/purpose.md`, `docs/intent.md`, and
`docs/taste.md` before changing anything.

## Verify command

```sh
npm run dev     # then drive it in a browser — screenshot the running game
npm run build   # must succeed with no warnings before any commit
```

**Compiling is not verification.** That mistake is precisely what parked the
predecessor. A change to movement is verified by running the course; a change
to art is verified by a screenshot from the actual gameplay camera.

## Hard rules

1. **Zero external assets.** No image, model, font, or audio file enters this
   repo. Every mesh is generated geometry, every texture is a canvas or shader,
   every sound is Web Audio synthesis. `three` is the only runtime dependency.
2. **Geometry and collision come from one declaration.** Never add a visible
   surface without its collider, or a collider without its surface. See
   `src/level.js` — everything routes through `solid()` / `decor()`.
3. **Momentum is sacred.** Any change that silently scrubs player speed is a
   bug, not a balance decision.
4. **Never trap the cursor without an escape.** Pointer lock only on an
   intentional click; Escape always releases.
5. **No inline `TODO:` comments.** Open work goes in `docs/roadmap.md` as an
   unchecked checkbox.
