import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * `SKYLINE_SCRATCH=1` adds the void-kit scratch stage (`voidkit.html`) to the
 * build.
 *
 * It is OFF by default and deliberately so: the stage exists to photograph
 * `src/voidkit.js` in isolation through the real pipeline, and it is not part
 * of the game. A dev-only page that ships is a page nobody maintains and
 * everybody can reach. `tools/voidshots.mjs` sets the flag for its own build;
 * `npm run build`, `tools/ship-gate.sh` and any deploy do not, so the shipped
 * bundle is byte-identical to what it was before this page existed.
 */
const scratch = process.env.SKYLINE_SCRATCH === '1'

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1', port: 5183, strictPort: true,
    // DO NOT WATCH THE AGENT WORKTREES. `.claude/worktrees/` holds a full
    // checkout per dispatched lane — fourteen of them during the void theme
    // session — and vite walks every one, which exhausts the system's inotify
    // watch limit and kills the dev server with ENOSPC on startup. The lanes
    // are not sources for this build; watching them is pure cost.
    watch: {
      ignored: ['**/.claude/**', '**/.orc/**', '**/dist/**', '**/shots/**'],
      // POLLING, because this box's inotify budget is exhausted and the dev
      // server dies on startup with ENOSPC — it cannot get a watch on the repo
      // root, never mind the tree. Raising fs.inotify.max_user_watches needs
      // root and is the real fix; polling is what works without it. Costs some
      // idle CPU and adds up to `interval` ms of latency to HMR, which is a
      // fair trade for a server that starts at all.
      usePolling: true,
      interval: 300,
    },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 1024 * 1024,
    ...(scratch
      ? {
        rollupOptions: {
          input: {
            main: resolve(process.cwd(), 'index.html'),
            voidkit: resolve(process.cwd(), 'voidkit.html'),
          },
        },
      }
      : {}),
  },
})
