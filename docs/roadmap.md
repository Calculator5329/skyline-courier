# Roadmap

## Now — graphics push (Ethan 2026-07-25: "much better graphics")

The reference project reaches its look with **zero image files**; the quality
comes from shader technique, not from textures. In priority order:

- [ ] **Triplanar projection + macro-noise normal tilt** on the surface
      material. The normal tilt is ~6 lines and is the single cheapest way to
      stop a box reading as a box — it perturbs the shading normal by the
      gradient of a low-frequency noise field so flat slabs catch light in
      swales and ridges. Highest payoff per line available to us.
- [ ] **Two-band macro albedo/roughness variation** (1–4 m and 8–16 m) so
      surfaces vary at both close and distant read.
- [ ] **Screen-space contact shadows** (~40 lines of GLSL, needs a depth +
      view-normal target). This is what stops ledges and blocks looking like
      stickers pasted on walls — and in a parkour game those are exactly the
      objects the player is judging.
- [ ] **Wall/ground dust wedge** — a 25–40 cm gradient at every junction. A
      razor-sharp wall/floor line is an instant "untextured primitive" tell.
- [ ] **Analytic sky IBL through PMREM** (~100 lines) with the "ambient must
      be ~20% of key" rule, replacing the flat hemisphere light.
- [ ] Stochastic de-tiling with height-preserving blend, once real detail maps
      exist to tile.

## Next — feel and content

- [ ] Hands-on playtest by Ethan — the acceptance gate for movement feel.
- [ ] Audio pass: current cues are placeholder-grade. Adopt the reference's
      `transient + body + texture + debris` layering, round-robin timbre
      variants per event, and a 9-ray space probe driving reverb blend.
- [ ] Visible courier hands with spring-driven lag and a grapple-cuff
      silhouette — the fiction already calls for them.
- [ ] Extend the course past the current opening leg to a full 3–5 minute route.
- [ ] Best-time persistence per checkpoint split (localStorage).
- [ ] Register the repo in `workspace.json` (manifest change needs its own lane).

## Later — capability probe (Ethan 2026-07-25: "3 later")

Does not start until the playable slice is accepted.

- [ ] Custom render pipeline: HDR targets, cascaded shadows, TAA, bloom pyramid.
- [ ] BVH broadphase over a triangle soup, replacing the AABB-only collider.
- [ ] Full Web Audio spatialisation: HRTF panning, occlusion raycasts, IR reverb.
- [ ] Playwright headless screenshot + frame-time harness for self-verification.

## Done

- [x] 2026-07-25: Scaffolded the repo — Vite 7 + Three.js r180, workspace docs
      pattern, and the purpose/intent/taste briefs carried over from the parked
      Clockwork Garden.
