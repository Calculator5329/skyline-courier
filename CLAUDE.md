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

1. **Zero external art assets.** No image, model, or font file is LOADED BY THE
   GAME. Every mesh is generated geometry and every texture is a canvas or
   shader. `three` is the only runtime dependency.

   **This bans assets the game SHIPS, not documents the team READS.**
   Reference images live in `docs/reference/` and are welcome there — they are
   never imported, never bundled, and `vite build` never sees them. Ethan,
   2026-07-26, correcting me for refusing to save his reference image into the
   repo: *"NOooooo it has to reference the exact file. Who bans image files? I
   dont."* He is right; I had over-applied this rule to art DIRECTION, which is
   the opposite of what it is for. A written description of a reference is a
   lossy copy of a file we could simply have kept.

   **The second exception is a far sky dome** (Ethan, 2026-07-26, approving
   option C when asked): ONE painted panorama per theme, drawn at effectively
   infinite distance behind everything, may be a real image file. It carries
   the "and it keeps going forever" read that no affordable amount of geometry
   can, and it is the cheapest pixel in the renderer — one textured sphere.

   It qualifies on exactly the terms the music exception qualifies on: authored
   once, judged once, and never reconciled against geometry, rigging or a
   camera. It has none of the properties that stalled the predecessor. This is
   NOT permission to reopen the art-asset pipeline — a dome is a backdrop, and
   anything the player can approach, occlude, or land on is still generated.

   **The third exception is a painted decal on a flat play surface** —
   currently exactly one, `public/tex/void-slab-top.png`, which Ethan supplied
   for the top face of the void's platforms. See `src/materials/slabdecal.js`
   for the mapping rule and the full argument; the short version is that a flat
   image on a flat face has none of the properties that stalled the
   predecessor. There is no mesh to clean up, no rigging, and no silhouette to
   reconcile against a collider — `runeSlab` declares the collider exactly as it
   did before and the image is painted onto the face that collider already had.
   Authored once, judged once.

   The limits are the point: it faces geometry that is ALREADY THERE, it never
   changes what is solid, and the procedural path it replaces stays live as the
   fallback (aspect gate, `detail: 0`, and a failed load all keep working). This
   is NOT permission to load meshes, and "a decal would be easier" is not a
   reason to add a second one.

   **The first exception is music** (Ethan, 2026-07-25): `public/audio/*.ogg` are
   generated tracks and are allowed. All *sound effects* remain Web Audio
   synthesis with no files — footsteps, landings, brass, wind, the lot.

   The distinction is not arbitrary. The rule exists because generated-3D-asset
   intake is what stalled the predecessor: it needed hands-on cleanup and
   in-viewport judgement on every single item, so the loop could never verify
   its own work. A music track has none of those properties — it is authored
   once, judged once, and never needs to be reconciled against geometry,
   rigging, or a camera. Do not read this exception as permission to reopen the
   art-asset pipeline.
2. **Geometry and collision come from one declaration.** Never add a visible
   surface without its collider, or a collider without its surface. See
   `src/level.js` — everything routes through `solid()` / `decor()`.
3. **Momentum is sacred.** Any change that silently scrubs player speed is a
   bug, not a balance decision.
4. **Never trap the cursor without an escape.** Pointer lock only on an
   intentional click; Escape always releases.
5. **No inline `TODO:` comments.** Open work goes in `docs/roadmap.md` as an
   unchecked checkbox.
