# The geometry unlock

Ethan, 2026-07-25, looking at a screenshot next to the reference: *"still
pretty blocky, and still far off the reference."*

He is right, and the cause is architectural rather than a lack of polish.

## The diagnosis

Audited on 2026-07-25: **every object in the world is an axis-aligned box.**
`src/level.js` has one emitter, `_emit()`, which walks a fixed six-entry
`FACES` table. Across the whole project there is not a single curved geometry —
no cylinder, no lathe, no extrusion, no tube. The only non-box meshes are the
sky sphere, the lantern icosahedron, and two flat quads used by the FX layer.

No shader can fix this. A box lit perfectly is still a box. The reference is
built from arches, domes, drums, gear teeth, and — most of all — plants.

## The root cause, and why it was a reasonable mistake

Two decisions, each correct alone, were chained together:

1. **`solid()` emits the mesh and the collider from one declaration.** This
   exists because the predecessor project died of exactly the opposite bug:
   surfaces you could see but not stand on, and surfaces you could stand on but
   not see. The invariant is worth keeping.
2. **Collision is axis-aligned boxes**, because a wall-run has to behave
   identically every time far more than it has to be geometrically general.

Chaining them means **the art is constrained to whatever the physics can
represent**. That is backwards. No shipped game ties its visual mesh to its
collision primitive; they share a *contract*, not a representation.

## The change

Keep the invariant. Break the representation link.

```js
// today — the box IS the visual and the collider
L.solid(cx, cy, cz, sx, sy, sz, 'porcelain')

// after — the collider is still an AABB, the visual is anything
L.solid(cx, cy, cz, sx, sy, sz, 'porcelain', {
  mesh: lathe(profile, { facets: 24 }),   // or extrude, sweep, shell, custom
})
```

Rules that must survive:

- Passing no `mesh` keeps today's behaviour exactly. This is a pure extension;
  nothing existing changes meaning.
- The collider is still declared in the same call, so **a walkable surface can
  never exist without a collider**. The safety property is preserved by the API
  shape, not by discipline.
- The custom mesh's footprint must not extend *beyond* the collider anywhere a
  player could stand on the overhang. Inset is fine; overhang is the old bug.
  A dev-only visualiser that draws colliders as wireframe should ship with this.

## What to build on top

### 1. `src/props.js` — generated architectural geometry
Real curves, merged per material like everything else:
- `lathe(profile, facets)` — drum platforms, column shafts, domes, urns, bells.
- `extrude(shape, path)` — arches, mouldings, cornices, balustrade rails.
- `sweep(curve, radius)` — vines, pipes, orrery rings, hanging chains.
- `gear(teeth, radii)` — real involute-ish teeth, not stepped boxes.
- `shell(...)` — the observatory dome and its rib cage.
- Chamfer/bevel every hard arris. Sharp 90° edges are most of the "blocky"
  read; even a 2 cm bevel catches a highlight and reads as carved.

### 2. `src/foliage.js` — the biggest single win
Vegetation is roughly 40% of the reference by screen area and we currently
have **none** — only moss-coloured boxes. This needs:
- Instanced, alpha-tested cross-quads for leaf clusters, ivy, grass tufts and
  flowers, with a procedurally generated atlas (canvas, still no image files).
- Trunk/branch geometry from `sweep`.
- Cheap vertex-shader wind, phase-offset per instance.
- Density driven by surface normal and by the same macro-noise field the
  materials already use, so vegetation grows where the material says it is damp.
- Aggressive LOD and distance fade — this is where the frame budget will go.

### 3. Silhouette and ornament pass
The reference has detail at 10 cm, 1 m, and 10 m. We have it at one scale.
Ledges, cornices, brass banding, rivets, finials, and hanging vines all break
up a straight edge, and a broken edge is what stops reading as a primitive.

## Order of work

1. `solid()`/`decor()` take an optional mesh factory. Collider unchanged.
2. `src/props.js` with lathe + extrude + chamfer. Rebuild the kit's prefabs on
   real curves instead of stacked boxes.
3. `src/foliage.js`. Expect this to move the needle more than 1 and 2 combined.
4. Re-run the adversarial critic workflow against the new geometry — the
   critics were previously scoring something that could not reach the bar.

## The thing to watch

Triangle count and draw calls. Today the whole world is a handful of merged
draw calls and runs at 0.1 ms/frame, which is an enormous budget to spend. Spend
it deliberately: merge by material, instance the foliage, LOD everything the
player cannot reach, and measure with `tools/capture.mjs` after each step rather
than at the end.
