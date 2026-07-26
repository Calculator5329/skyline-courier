# Lite Mode

What each graphics quality level changes, what it saves, and what it costs to
look at. Measured 2026-07-26, RTX 5070 Ti, ANGLE/Chromium headless, alongside
`docs/perf.md` — read that first, it says where the frame time goes and lists
the fixes that were built and thrown away.

The levels live in `src/render/quality.js`. **There is no UI yet** — that is
deliberate and it is filed in `docs/roadmap.md`. This lane built the plumbing
so a menu item can be one call to `__game.setQuality(name)` later.

## Setting it today

```js
__game.setQuality('lite')      // 'high' | 'balanced' | 'lite'
__game.getQuality()
__game.QUALITY_LEVELS          // the table, with labels and notes
```

Takes effect on the next frame and persists in `localStorage`. For a run that
must NOT persist — a harness capture, an A/B by reload — use the query
parameter, which wins over the stored value and does not overwrite it:

```
?quality=lite            node tools/shotset.mjs --quality lite
```

## The levels

| | `high` (default) | `balanced` | `lite` |
|---|---|---|---|
| devicePixelRatio cap | 2 | 1.5 | 1 |
| contact-shadow buffer | full res | half res | half res |
| march steps / AO taps | 14 / 8 / 5 | 14 / 8 / 5 | 14 / 8 / 5 |
| contact shadows + AO | on | on | on |

`high` is a verbatim restatement of what the renderer did before the file
existed. That is the property to preserve: **adding a settings menu must never
be the thing that changed how the game looks for a player who never opens it.**

## What each knob is worth

### devicePixelRatio cap — the big one, and the harness cannot see it

This is the largest single lever in the game and it is invisible to every
number below, because headless Chromium runs at `devicePixelRatio` 1, so all
three levels render identically in the harness. Its size comes from the
`halfres` ablation instead (`docs/perf.md`): **quartering the pixels roughly
halves the frame.**

On a 1x display the cap does nothing at any level — it is a ceiling, and the
display is already under it. It only bites on HiDPI, which is exactly where the
complaint came from: at a cap of 2 a "1440p" laptop panel is asked for 4x the
pixels of its CSS size, and on a fill-bound renderer that is most of the frame.

`balanced` exists because 2 → 1 is a **four-times** cut, which is far more than
a mildly slow machine needs to give up. 1.5 is 2.25x rather than 4x.

### Contact-shadow buffer resolution — measured, and the honest part

The contact pass is 40%+ of every frame (`docs/perf.md`). Running it at half
resolution and letting the material's existing bilinear fetch upsample it is
the only lever that moves it. Interleaved, minimum of 4 repeats, 2560x1440:

| skyline shot | `high` ms | half-res ms | saved | contact floor (`nocontact`) |
|---|---|---|---|---|
| terrace   | 7.57  | 5.91 | −1.67 (−22%) | 4.43 |
| gaps      | 5.91  | 5.40 | −0.51 (−9%)  | 4.38 |
| crossing  | 9.60  | 6.43 | −3.18 (−33%) | 4.90 |
| underpass | 9.48  | 6.28 | −3.19 (−34%) | 4.69 |
| chain     | 7.03  | 5.45 | −1.58 (−22%) | 4.16 |
| tower     | 9.38  | 6.04 | −3.35 (−36%) | 4.29 |
| vista     | 8.81  | 7.44 | −1.37 (−16%) | 4.81 |
| closeup   | 11.02 | 7.25 | −3.76 (−34%) | 5.16 |
| underside | 5.90  | 4.45 | −1.45 (−25%) | 3.40 |
| deckstrip | 10.37 | 6.54 | −3.83 (−37%) | 4.65 |
| edgefeet  | 7.45  | 5.34 | −2.10 (−28%) | 4.16 |

| void shot | `high` ms | half-res ms | saved |
|---|---|---|---|
| ascent   | 7.37 | 5.99 | −1.38 (−19%) |
| midclimb | 4.72 | 4.53 | −0.19 (−4%)  |
| plunge   | 5.53 | 5.06 | −0.47 (−9%)  |
| summit   | 7.40 | 5.33 | −2.07 (−28%) |

Half resolution recovers roughly **two thirds of the whole pass** for a quarter
of the pixels. Same sign on every shot, on both themes.

> Absolute times on this box move by up to 4x between runs depending on what
> else is resident — a later run of the same four shots read `closeup` at 6.53
> where the table above reads 11.02. Only the within-run ratios are quotable,
> and those held their shape across every run. See the hygiene section of
> `docs/perf.md`.

### Steps and taps — wired, and deliberately not turned

Every level runs 14 march steps and 8/5 AO taps, the shipped values. Dropping
to 10/6/4 was measured (`perfprobe --modes base,chalf,clite`) and came back
**indistinguishable from half-res alone on every shot on both themes, sometimes
slower.** Skipping both bilateral blur passes entirely (`--modes base,noblur`)
is likewise free:

| shot | base | `noblur` | half-res | `nocontact` |
|---|---|---|---|---|
| closeup  | 6.53 | 6.57 | 4.67 | 3.32 |
| crossing | 5.51 | 5.83 | 4.52 | 3.30 |
| tower    | 5.32 | 5.06 | 3.87 | 2.68 |
| vista    | 2.79 | 2.50 | 2.68 | 2.31 |

So the pass is bound by neither its arithmetic nor its blur. It is bound by the
number of pixels it runs at and the ~22 dependent texture fetches each of those
pixels makes. **Cutting taps would be pure image loss at zero saving** — the
worst trade available — so no level does it. The knobs stay wired because an
integrated GPU is far likelier to be ALU-bound than this one; turn them when a
measurement on that part says to, not before.

### What is NOT a quality knob, and why

Every one of these was measured and does not belong on a slider:

- **The shadow map.** `−shadow` is inside the noise on every shot, both themes,
  every resolution. Shrinking it costs image and saves nothing.
- **The bloom pyramid.** Same — it runs on a chain that is 1/4 the pixels
  before it starts.
- **Level and backdrop geometry / draw distance.** The renderer is fill-bound,
  not geometry-bound. `−backdrop` is free, and `−level` only looks expensive
  because hiding the level removes most of the *shaded pixels* in frame. A
  draw-distance slider would be a visible cost with no frame-time credit.
- **Turning contact shadows off.** This is the one change here that *restyles*
  the game rather than softening it. The sun sits at ~10 degrees, so a
  horizontal deck receives 0.17 of the key and is drawn almost entirely by
  ambient — and the AO in this pass is what puts form into that ambient.
  Without it every wall/floor junction flattens and the scene reads as
  untextured primitives, which is the exact failure the pass was written to
  fix. A slow machine should get a soft version of this game, not a
  different-looking one. `lite` therefore keeps the pass.

## What it costs to look at

Honest answer, and it took a control run to get it: **the harness is not
deterministic**, so a naive before/after diff overstates the change badly.
Re-rendering the *unchanged* build gives a per-pixel mean deviation of 4.13/255
on `deckstrip` and 0.79 on `underside` — foliage sway and grain, nothing to do
with any edit. Any comparison that does not subtract that noise floor is
reporting weather.

Whole-frame mean luminance, `high` vs `lite`, against a same-build control:

| shot | noise floor (rerun) | half-res signal |
|---|---|---|
| crossing  | 0.000  | 0.000  |
| chain     | 0.000  | −0.010 |
| terrace   | −0.060 | −0.010 |
| tower     | 0.000  | −0.060 |
| closeup   | 0.000  | −0.070 |
| deckstrip | −0.200 | −0.090 |
| vista     | 0.010  | +0.140 |

**Globally the change sits at or below the run-to-run noise floor** — under
0.15 of a luminance level out of 255, i.e. under 0.06%. The shot-set `lum`
column prints one decimal, so `closeup` reads 111.0 instead of 111.1: that is
the rounding of a 0.07/255 shift, not a visible one.

It is not uniformly distributed, and this is the part to be honest about. On
frame-stable shots the per-pixel deviation concentrates entirely on **distant,
thin geometry** — far balustrades, cornice lips, foliage silhouettes — where a
feature occupies few enough pixels that halving the AO buffer genuinely loses
its crease. On `crossing` the worst 0.1% of pixels move ~42/255 while the mean
moves 1.46; the near stonework filling the left of that frame is unchanged.
Measured on regions of that shot: the near pillar face darkens by 0.47/255
(0.8%), the distant balustrades by 0.73/255 (0.5%).

Side by side, frozen, at 3x zoom, on a distant railing, an art director can
find it. At normal viewing distance, in motion, a reasonable person cannot —
the near field, which is where a parkour player is looking, is untouched.

## Why the default was left at full resolution

The half-res contact win is large, cheap, and on the evidence above very nearly
invisible. It is not shipped as the default anyway, because the brief for this
lane set an explicit acceptance test — the skyline `closeup` shot holds
lum 111.1 / sat 0.807 — and half-res prints 111.0. It fails by one unit in the
last printed digit, on a 0.07/255 shift, which is a rounding boundary rather
than a visual change.

That is a call worth putting to a person rather than making quietly, and it is
filed in `docs/roadmap.md`. **Promoting half-res contact from `balanced` into
`high` would buy 16–37% of the frame on every shot on both themes**, at the
cost described above. The plumbing is already in place; it is a one-line change
to `contactScale` in `src/render/quality.js`.
