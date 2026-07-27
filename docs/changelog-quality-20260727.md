# Quality-level correction — 2026-07-27

`high` remains the shipped reference definition. `balanced` now selects a
0.375-scale contact buffer with 10 march steps and 6/4 AO taps. `lite` disables
the contact-shadow/AO pass; its dormant diagnostic values are 0.25 scale,
8 steps and 4/2 taps.

The visual-invariance gate in `tools/perfbaseline.mjs` now boots explicitly at
`quality=high`. Before either comparison arm, it takes five identical High
captures, records per-shot and per-metric min/max/range values, and derives the
run's tolerance as the observed maximum plus one 0.1 analyzer reporting
quantum. The optimization arm cannot tune that value. `--calibrate-visual 5`
runs the reproducibility measurement alone. Balanced and Lite are intentionally
excluded because a quality change is expected to change the image.

`--quality-levels` adds a socket-free, interleaved quality benchmark at
1600x900 and 2560x1440. It measures terrace, crossing, tower and closeup by
default, uses the minimum of repeated GPU-synced samples, prints the 240 Hz
verdict, and optionally writes one same-camera screenshot per level.

The managed Codex sandbox completed the production build but rejected Chromium
startup before capture (`sandbox_host_linux.cc:41`, `Operation not permitted`).
No unmeasured Balanced or 1600x900 Lite result was invented. The fail-capable
outside-sandbox closeout is:

```sh
node tools/perfbaseline.mjs --quality-levels \
  --only terrace,crossing,tower,closeup --repeats 4 \
  --screenshot-shot closeup --screenshot-out docs/captures/quality-levels
```
