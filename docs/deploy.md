# Deploy

Public URL: **https://skyline-courier-5329.web.app**

Firebase project `skyline-courier-5329` ("Skyline Courier"), Hosting only —
no Firestore, no Functions, no Firebase SDK in the bundle. The game is a
static build and stays that way.

## Ship it

```sh
npm run ship        # push main, then deploy that exact commit
```

That is the whole process. Anyone with the link can play; no sign-in.

`ship` pushes `main` to `origin`, then builds from a throwaway export of
`HEAD` — so what goes live is exactly what is committed and pushed, even
when the working tree is mid-edit by an agent. It refuses to run off `main`,
and `SHIP_DRY_RUN=1 npm run ship` exercises everything but the push and the
deploy.

```sh
npm run deploy      # vite build && firebase deploy --only hosting
```

`deploy` is the lower-level escape hatch: it ships the **working tree**,
uncommitted changes included, and does not push. Use it to put a local
experiment in front of someone; use `ship` for anything real.

To preview the production build with the real hosting headers before
shipping, run the `skyline-firebase-verify` launch config (serves `dist/`
through the Firebase emulator on :5000) — the plain `npm run preview` does
not apply `firebase.json` headers.

## Why the config looks the way it does

- **`public: dist`** — Vite output. `base: './'` in `vite.config.js` keeps
  asset paths relative, so the bundle also works from a subpath or a local
  `file://` open.
- **`index.html` is `no-store`; `assets/**` is `immutable` for a year.**
  Vite content-hashes asset filenames, so a redeploy is visible on the next
  reload with no cache-busting dance.
- **Strict CSP (`default-src 'self'`).** The zero-external-assets rule in
  `CLAUDE.md` means nothing needs to be allowlisted. `style-src` carries
  `'unsafe-inline'` for the `<style>` block in `index.html`; `img-src`
  allows `data:`/`blob:` for canvas-generated textures. If a future change
  ever needs a network origin, that rule is the thing to revisit — and it
  should be treated as a signal the asset rule is being bent.
- **SPA rewrite** — single entry point, so any path lands on the game
  instead of a 404.

## Verified

2026-07-25, commit `96adebd`, via the Firebase hosting emulator:
build clean (577 kB / 156 kB gzip), game boots, WebGL context healthy,
no console errors, and all headers above confirmed on the wire.
