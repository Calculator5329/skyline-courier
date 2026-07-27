# Settings changes — 2026-07-27

- Added one explicit Apply action for fullscreen, music, mouse sensitivity,
  movement scheme, and graphics quality.
- Settings now show when edits are unapplied. Leaving the Settings pane or
  pressing Escape cancels the edit and restores slider previews.
- Kept Look as the intentional reload-on-change exception because it selects
  geometry baked at boot.
- Routed both the Quality segmented control and `__game.setQuality()` through
  the same complete renderer resize path, so a live High → Lite change
  recomputes the WebGL backing store and all dependent render targets.
