import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5183, strictPort: true },
  build: { target: 'es2022', assetsInlineLimit: 1024 * 1024 },
})
