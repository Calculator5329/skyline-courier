# Where the frame time actually goes

Measured 2026-07-26. GL: ANGLE / NVIDIA RTX 5070 Ti, Chromium headless with
the harness GPU flags. Instruments: `tools/perfprobe.mjs` (ablation),
`tools/perfinv.mjs` (scene inventory), `tools/hitch.mjs` (frame-time
distribution while running).

This document exists because the obvious diagnosis was wrong, and a second
agent starting from the same symptom would reach the same wrong answer and
spend the same day disproving it.

## 2026-07-27 consistency receipts

A mean is no longer a performance receipt in this repository. `shotset`,
`perfbaseline`, its live-rAF audit, and `hitch` now use the same frame-time
summary from `tools/hitch.mjs`:

- mean and p99 frame time;
- 1% low FPS (`1000 / p99 frame time`);
- population standard deviation across every synchronized pumped frame;
- hitch count above the existing 60 Hz budget (16.667 ms), plus the worst
  hitch; and
- max frame time, retained in JSON and the running-course report.

The parked-shot tools settle the exposure and pipeline first, then time every
GPU-synchronized frame individually. Interleaved quality repeats select the
complete repeat with the lowest mean; the p99, deviation, and hitch fields all
come from that same repeat. Selecting each statistic from a different repeat
would manufacture a distribution that never occurred.

For a 240 Hz verdict, zero 16.667 ms hitches is necessary but not sufficient:
p99 must also fit inside 4.167 ms. Thus a 3 ms mean with a 7 ms p99 is reported
as **not consistent at 240 Hz**, even if it never crosses the broader hitch
threshold. Infrastructure failures and missing/non-finite samples fail closed.
`node tools/hitch.mjs --self-test` exercises both accepted steady/hitched
samples and rejected empty/non-finite inputs.

## 2026-07-27 real-frame audit

The production loop is a direct `requestAnimationFrame(frame)` recursion. It
does not contain a timer, sleep, frame divisor, `setAnimationLoop`, or FPS cap.
The 120 Hz fixed step controls physics only: every rAF still draws once. For a
physical-display measurement rather than a pumped headless shot, run:

```
node tools/perfbaseline.mjs --live --headed
```

That drives the actual game loop while running forward+sprint, at native
1920x1080 and 2560x1440, records rAF pacing, and performs an audit-only
`readPixels` after each frame so completed time includes the GPU. It prints the
same consistency fields as the parked-shot tools plus headroom against the
4.167 ms 240 Hz budget. The readback is installed before the app only for this
mode; there is no readback or fence in production.

### What the audit found

| area | before | shipped action | image consequence |
| --- | --- | --- | --- |
| JS/GC | Running 20 s at 1440p measured 2.48 ms mean, 4.00 ms p99, 5.10 ms max, with no GC-shaped hitch train and zero frames over 16.7 ms. | Kept per-frame scratch preallocated; the live audit now also records JS heap range. | None |
| scene discovery | A whole-scene traverse, material classification, and light-budget recomputation every 60 frames, although `scene.add` occurs only before `RenderPipeline` construction. | Walk once, then invalidate only from the setters that can change derived state. | None; same cached objects and uniforms |
| static transforms | Three recomposed and multiplied the static level tree in both the depth/normal prepass and beauty pass. | Resolve once in `Level.build()`, then disable local/world matrix auto-update on the tagged static subtree. Shader animation is unaffected. | None; matrices are the same values |
| void emitters | Sort all (up to 96) pooled emitters by camera distance every frame to use 16. | Stable nearest-16 insertion selection with fixed typed-array scratch. | None; exact same ordered 16, including tie order |
| sun target | `world.update()` updated the target matrix explicitly; the immediately following scene render updated it again before shadow-matrix use. | Removed the first update. | None; the consuming render still updates it |
| contact shader | Up to 27 dependent normal-buffer fetches repeated a coverage fact already present in the fetched positive linear depth. | Reuse depth for coverage. | Executable old/new shader arms use the recalibrated High-only lum/p1/p50/p99 gate described in `docs/lite-mode.md`. |
| shadow scheduling | The prepass already suppresses shadow updates. The beauty pass renders one 2048² map each frame because its orthographic frustum follows the moving player. `noshadow` measured inside noise: −0.20 to +0.08 ms on the quoted 1440p shots. | Kept one update per frame. On-demand updates would make a continuously moving shadow projection stale, while the measurable saving is zero. | None |
| targets / sync | `setSize` early-outs and is called only at boot, resize, or a quality change. No render target is allocated in `render()`. Exposure stays GPU-side through a 1x1 texture. Production contains no `readPixels`, `finish`, or fence. | No change needed. | None |

`tools/perfbaseline.mjs` switches every shipped optimization above back to its
old implementation in one build, captures every skyline and void shot, reports
CPU queue time and the full GPU-synced consistency distribution separately,
and fails if any shot moves past the run's measured High-only visual tolerance.

### The 240 Hz limit that remains

240 Hz allows **4.167 ms for the entire frame**. The already measured native
2560x1440 skyline range is 2.53–6.47 ms depending on view; four of the five
quoted representative shots exceed budget:

| skyline shot | native 1440p | headroom to 4.167 ms | without contact (diagnostic only) |
| --- | ---: | ---: | ---: |
| terrace | 4.80 | −0.63 | 2.90 |
| crossing | 5.52 | −1.35 | 3.11 |
| tower | 5.04 | −0.87 | 2.57 |
| vista | 2.53 | +1.64 | 2.06 |
| closeup | 6.47 | −2.30 | 3.18 |

The CPU bookkeeping fixes recover headroom and remove avoidable periodic work,
but they cannot make a 6.47 ms fill-bound view fit in 4.167 ms. The remaining
decision is image-affecting: contact-buffer resolution and pixel-ratio cap.
Those already live in the quality levels documented in `docs/lite-mode.md`;
half-resolution contact measured a 16–37% saving, and quartering total pixels
roughly halves the frame. MSAA and the high-quality pixel-ratio cap were not
changed by this audit.

### 2026-07-27 handoff

- **Shipped, closed:** checkpoints `2ee7105`, `3d66258`, and `e497570` contain
  the event-driven scene walk, frozen level matrices, nearest-16 emitter
  selection, single sun-target update, combined audit switch, and live-rAF
  instrument described above.
- **Named, not built:** no MSAA, contact resolution, render scale, or
  pixel-ratio default changed; those are visible quality-menu decisions, not
  image-invariant frame-audit work.
- **Found, unresolved:** this Codex sandbox cannot launch Chromium
  (`sandbox_host_linux EPERM`). Run `node tools/perfbaseline.mjs`, then
  `node tools/perfbaseline.mjs --live --headed`, outside the sandbox and paste
  the emitted old/new CPU, synced, visual, 1080p, and 1440p rows into the
  2026-07-27 changelog entry. No after value has been inferred from static
  analysis.

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

## What the contact pass is actually bound by (2026-07-26, follow-up)

The table above says the contact pass is 40%+ of the frame. It does not say
WHICH part of it, and the three candidate answers have completely different
fixes. Measured, with `perfprobe --modes`:

- **Fewer steps and taps buys nothing.** 10 march steps and 6/4 AO taps instead
  of 14 and 8/5 (`clite`) read indistinguishable from half-resolution alone on
  every shot on both themes, and slower on some.
- **The two bilateral blur passes cost nothing.** `noblur` is inside the noise
  (closeup 6.53 base vs 6.57; tower 5.32 vs 5.06).
- **Only resolution moves it.** Half-resolution (`chalf`) recovers roughly two
  thirds of the whole pass, on every shot, on both themes.

So the pass is not ALU-bound and it is not blur-bound. It is bound by the
number of pixels it runs at and the ~22 dependent texture fetches each of those
pixels makes. **There is no free win in the largest item in the renderer** —
the only lever is resolution, and resolution is a (small, measured) image
change. That is why it went behind Lite Mode rather than into the default; see
`docs/lite-mode.md` for the frame times and the visual assessment.

### The shot harness is not deterministic — subtract the noise floor

This cost real time to discover and it invalidates any naive before/after diff.
Re-rendering the UNCHANGED build and diffing the two shot sets gives a
per-pixel mean deviation of **4.13/255 on `deckstrip`** and 0.79 on
`underside` — foliage sway and grain, nothing to do with any edit. A candidate
that measured 4.93 on that shot had therefore changed almost nothing.

Some shots ARE frame-stable: `crossing`, `chain`, `closeup`, `tower` and
`terrace` all reproduce their whole-frame mean luminance exactly across runs.
Those are the ones to quote. Always capture a same-build control run and report
the signal against it, not against zero.

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
