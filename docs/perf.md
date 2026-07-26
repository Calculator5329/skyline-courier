# Where the frame time actually goes

Measured 2026-07-26. GL: ANGLE / NVIDIA RTX 5070 Ti, Chromium headless with
the harness GPU flags. Instruments: `tools/perfprobe.mjs` (ablation),
`tools/perfinv.mjs` (scene inventory), `tools/hitch.mjs` (frame-time
distribution while running).

This document exists because the obvious diagnosis was wrong, and a second
agent starting from the same symptom would reach the same wrong answer and
spend the same day disproving it.

## The symptom, and what it is not

"The void lags."

It is not a stutter. `tools/hitch.mjs` drives the void for 20 s of real
running at 2560x1440 and finds **zero** frames over 16.7 ms:

```
mean 2.48   p50 2.40   p95 3.50   p99 4.00   max 5.10 ms
over 16.7 ms: 0 frames
```

So there is no hitch, no GC saw-tooth, no shader-compile stall in the running
loop. Whatever "lags" means, it is throughput, and it is therefore a function
of how many pixels the player's display asks for — see the pixel-ratio item in
`docs/roadmap.md`.

## The bound is FILL, not geometry

Ablation at 2560x1440, minimum of 4 interleaved repeats per mode:

| shot (void) | base | −shadow | −level | −backdrop | −bloom | half-res | −contact |
|---|---|---|---|---|---|---|---|
| ascent   | 4.70 | 4.71 | 2.20 | 4.60 | 4.65 | 2.49 | **2.73** |
| midclimb | 2.91 | 2.88 | 1.96 | 3.00 | 2.98 | 2.11 | **2.01** |
| plunge   | 3.46 | 3.41 | 2.05 | 3.53 | 3.57 | 2.36 | **2.68** |
| summit   | 4.36 | 4.33 | 2.22 | 4.42 | 4.46 | 2.33 | **2.31** |

| shot (skyline) | base | −shadow | −level | half-res | −contact |
|---|---|---|---|---|---|
| terrace  | 4.80 | 4.84 | 2.46 | 2.36 | **2.90** |
| crossing | 5.52 | 5.60 | 2.17 | 2.44 | **3.11** |
| tower    | 5.04 | 4.84 | 2.04 | 2.34 | **2.57** |
| vista    | 2.53 | 2.49 | 1.88 | 1.81 | **2.06** |
| closeup  | 6.47 | 6.45 | 2.26 | 2.76 | **3.18** |

Three things fall out of that table and none of them is the triangle count:

1. **Quartering the pixels roughly halves the frame.** Fill.
2. **The contact-shadow pass is the single largest item** — 2.2–2.4 ms of a
   4.4–5.5 ms frame, 40%+, consistently, on both themes. It is a 14-step
   screen-space march plus an 8-sample AO spiral (`SC_CS_STEPS`,
   `src/render/contact.js`) run at full resolution: ~22 dependent texture
   fetches per pixel. Fill again.
3. **The shadow pass is free.** `−shadow` is inside the noise on every single
   shot, on both themes, at every resolution measured. The shadow map is
   2048², the geometry going into it is depth-only, and this GPU does not
   care.

`−level` looks large (2.0–2.5 ms) but that is the level's share of the FILL,
not its geometry: hiding it removes most of the shaded pixels in frame.

### `basicmat` is not a usable instrument

The probe has a mode that swaps the surface materials for stripped clones. It
reads *slower* than the real material almost everywhere, because the clone is
a second program and the scene ends up rendering both. It cannot distinguish
shader cost from fragment count and should not be quoted. It is left in place
only so the next person does not rebuild it and reach the same dead end.

## What was built, measured, and thrown away

### 1. Spatial chunking of the merged surface batches

The diagnosis that motivated this work: `Level.build()` merges every surface
of one material into ONE mesh. `tools/perfinv.mjs` confirms the shape of the
problem exactly — in the void, `surface:stone` is a single mesh of 881k
triangles with an **815 m bounding sphere**, so the frustum culler can never
reject any part of it, from anywhere, facing any direction. Every triangle is
submitted every frame, three times over (shadow map, depth/normal prepass,
beauty pass) — which is where `renderer.info`'s 2.94 M comes from against a
scene that only contains 1.05 M.

That is all true, and it is not the bottleneck.

Chunking was implemented in full: per-append part records, a derived cell size
(a ladder search, so a tall spiral and a long +X spine both get a sensible
scheme without a tuned constant), verbatim vertex copies with rebased indices,
and a tight `computeBoundingSphere()` per chunk. Bounding radii went from
815 m to 20–37 m. It worked exactly as designed. It did not help:

Cell-size sweep, void, 1600x900 (unchunked baseline: ascent **2.83**, summit
**3.24**):

| cell | draws | tris | ascent | summit |
|---|---|---|---|---|
| 24 m  | 1447 | 0.95 M | 4.39 | 4.84 |
| 32 m  | 1215 | 1.06 M | 4.27 | 4.57 |
| 48 m  | 887  | 1.12 M | 3.46 | 3.24 |
| 64 m  | 709  | 1.29 M | 2.90 | 3.17 |
| 96 m  | 458  | 1.51 M | 2.62 | 3.29 |
| 128 m | 338  | 1.82 M | 2.92 | 3.24 |
| 192 m | 233  | 2.15 M | 2.84 | 3.00 |

Culling 60%+ of the triangles bought nothing, and the draw calls needed to do
it cost real time. The monotone left-hand column is the draw-call bill; there
is no matching credit on the other side, because the triangles were never
being paid for.

Skyline, 2560x1440, back-to-back A/B, chunked vs merged — chunking is slower
at every shot:

| shot | merged | chunked | Δ |
|---|---|---|---|
| terrace  | 4.80 | 5.46 | +0.66 |
| crossing | 5.52 | 6.16 | +0.63 |
| tower    | 5.04 | 5.38 | +0.34 |
| vista    | 2.53 | 2.81 | +0.28 |
| closeup  | 6.47 | 6.79 | +0.32 |

Same sign on every shot. Not shipped. The one merged mesh per material is
still the right call on this hardware, for the same reason it was in the
beginning — it just stopped being right for the reason people assume.

**If you are about to rebuild this:** the honest trigger is an integrated GPU
or a course whose triangle count grows another order of magnitude, and the way
to know is to measure vertex throughput on the target part first. It is not a
hard change; `tools/perfinv.mjs` will tell you in one run whether the
bounding spheres are still the problem.

### 2. Shadow casting by distance

Dropped before it was written. The premise was that chunks outside the ±70 m
shadow frustum (`src/world.js`) should not cast — but three.js already
frustum-culls shadow casters against the shadow camera, exactly and per frame,
the moment the geometry is in cullable units. So this was never a separate fix
from chunking, and chunking is not shipping. Independently, `−shadow` measures
as free, so there is nothing here to win.

### 3. A depth prepass for backdrop overdraw

Not built, per the brief's own condition: only if fill is the bound AND the
backdrop is the fill. Fill is the bound; the backdrop is not it. `−backdrop`
is inside the noise on all four void shots at both resolutions, and the ruin
bands are already `castShadow = false` with `scNoPrepass` set. The overdraw is
not there.

## Measurement hygiene — read this before quoting a number

This box runs other agents' harnesses and Ethan's desktop Chrome (5 GB of
resident browser was normal during these runs). Absolute frame times moved by
up to 4x between runs of an identical configuration. Consequently:

- **Only compare arms measured back-to-back in one window.** Every A/B above
  was.
- `perfprobe` takes the **minimum** of 4 repeats and **rotates the mode order**
  per repeat. Both matter: with a fixed order the first mode measured was
  reliably the slow one (cold clocks), which silently penalised `base`, the
  one thing everything is compared against.
- Ratios within a run (half-res vs base, −contact vs base) held their shape
  across every run. The conclusions rest on those, not on absolute times.
- 3840x2160 is not measurable in this harness — headless Chromium silently
  stops rendering (0 draws, 0 triangles) rather than failing. If you see a
  suspiciously fast frame, check the draw count before believing it.
