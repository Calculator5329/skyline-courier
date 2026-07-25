# The world, round two

Ethan, 2026-07-25, after playing the round-one build:

> *"make the world much bigger and we can reuse a lot of the objects and stuff
> that we're using. just to make the course way more fun and way longer... what
> we currently have is like a round one or like the testing round and then make
> a much bigger one as well. but we don't need to like reinvent the wheel. we
> can just use current objects and then the future we can make different themes
> and stuff."*

## What this settles

1. **The existing course is kept, not replaced.** It is the proving ground —
   every verb is taught there in isolation and it is where movement changes get
   regression-tested. The big world is built *alongside* and *beyond* it, and
   the current course becomes its opening act.
2. **Reuse the kit. Do not author new one-off geometry.** `src/kit.js` already
   exports drums, arches, colonnades, balustrades, gears, armillaries, domes,
   cypress, vines, waterfalls and stairs. Scale comes from *composition and
   variation* of those, not from new prefabs. If something genuinely cannot be
   composed, add a parameter to an existing prefab before adding a new one.
3. **Variation must come from parameters, not from copies.** The critique's
   sharpest finding was that twelve islands in one frame had identical
   silhouettes because `discRects()` is fully deterministic in `r` and `facets`.
   Every prefab needs per-instance jitter driven by a seeded `rand`, so reuse
   reads as a *style* rather than as a copy-paste.
4. **Themes are future work, and the kit must not block them.** Do not build
   themes now. Do make sure the kit takes its palette and proportions as
   parameters, so a later "night", "storm" or "overgrown ruin" theme is a data
   change rather than a rewrite.

## Every island must be reachable

The single most-repeated playtest complaint: *"I can't get to the other
islands."* Currently every island past the route is `decor()` — visible,
unreachable, non-solid. That is the inverse of the bug that killed the
predecessor project and just as damaging.

Rules:

- Near and mid bands become **solid**. Only the far band stays scenery, pushed
  far enough out that no player can test it.
- **Reachable and escapable.** An island you can land on but not leave is a
  soft-lock, and with this movement set players will find every one.
- Verify **mechanically**, not by eye — see `tools/reachability.mjs`. It walks
  the traversal graph and fails on unreachable islands and dead ends.
- Build the archipelago as a **graph first, geometry second**: decide which
  island pairs should connect, then place the lantern that makes each edge
  exist. Grapple range is 34 m, so a lantern literally authors a connection.

## Scale targets

| | Round one (kept) | Round two |
|---|---|---|
| Route length | ~230 m | 900–1400 m travelled |
| Time at pace | ~45 s | 3–5 min |
| Vertical range | y 0 → 8 | y −20 → +90 |
| Shape | one straight axis | turns, doubles back, crosses over itself |
| Islands | 1 route + scenery | a connected archipelago |
| Branches | none | ≥3 fast/safe splits that rejoin |

Seeing your own earlier route from a new angle is most of what makes a
traversal world read as a *place* rather than a corridor. Prioritise
crossings-over-itself above raw length.

## Non-negotiables carried forward

- Everything at walkable height is `solid()`. Never `decor()`.
- Every checkpoint reachable from the previous one **without** dash or grapple.
  Those are for the fast line, not the only line.
- Deterministic: no `Math.random()` at module scope. Same world every reload.
- Frame budget: merge by material, instance the foliage, LOD anything the
  player cannot reach, and measure with `tools/shotset.mjs` after each step.
