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
  server: { host: '127.0.0.1', port: 5183, strictPort: true },
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
