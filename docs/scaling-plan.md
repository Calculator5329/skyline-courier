# Scaling to near-infinite content

Agreed with Ethan, 2026-07-25, in conversation. **Not started** — this is
queued behind getting the current build to a good graphical and movement state,
and behind a playtest and his feedback.

## Order: A → C → B

**A. The validator (first, and unglamorous).**
Nothing visibly changes. It is the prerequisite for both of the others, and it
immediately makes the existing agent fleets safer.

- An **invariant validator** over a prefab's emitted boxes. Fails on: decor at
  walkable height with a standable top face; collider/visual footprint
  mismatch; NaN transforms; blown triangle budget. Today "a visible surface at
  walkable height must be solid" is enforced by prose in a doc plus review —
  which is exactly the bug that killed the predecessor project, and an agent
  already reintroduced a variant of it once.
- A **per-prefab visual harness**: render ONE prefab on a neutral plinth from
  three angles. Cheap, fast, and lets a critic judge a prefab in isolation
  without loading the world.
- A **narrower, declarative API**. `L.solid(x,y,z,w,h,d,kind,opts)` with seven
  positional arguments is easy to get wrong. Describing the parts and letting
  the engine emit them is much harder to get wrong.

The principle: **you do not need a smarter model, you need a stricter
contract.** The better the framework, the weaker the model that can safely
author content inside it.

**C. The generator (second).**
Better positioned than it looks, because the hard part is already done:
`docs/course-design.md` quantifies the traversal envelope (free ≤7 m, double
jump ≤13, dash ≤19, grapple ≤34) and `tools/reachability.mjs` walks the
traversal graph. That checker is a **fitness oracle**, which is the thing that
separates usable procedural generation from noise. With it, generation becomes
generate → validate → repair → repeat.

**Hybrid, not pure PCG.** Procedural generation yields infinite *levels*, not
infinite *interest* — after ten islands a player has learned the grammar and
stops looking. Hand-author the set pieces and landmarks (the observatory, the
bell tower, one memorable crossing); generate the connective tissue between
them. Decide this before writing the generator, because it changes what the
generator is for.

**B. Themes (third).**
Measured: 48 hardcoded colours live outside `PALETTE` — 20 in `materials.js`,
28 across the shader, world and render. Lifting those into a `Theme` object is
mechanical, roughly a session.

The trap: **a theme is not a repaint.** The painters have structure baked in —
ashlar coursing, brass banding, rivet pitch. Palette-and-light themes (dawn,
dusk, night) are cheap. Structurally distinct themes (ruins, ice, industrial)
need the painters parameterised by structure too, which is 2–3 sessions and
worth doing once rather than bolting on.

## Model policy

**Opus 5 for everything**, confirmed again in this conversation — including the
content churn once the framework exists. The framework work is about making the
contract strict, not about making the model cheaper.

## Precondition

None of this starts until the current build is in a good graphical and movement
state, Ethan has played it, and his feedback has landed.
