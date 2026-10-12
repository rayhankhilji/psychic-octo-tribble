import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    // `npm run dev:server` serves live metrics on 8787; the client falls back to demo mode without it.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    // three.js is most of the bundle and changes far less often than the game:
    // its own chunk stays cached across our releases.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('node_modules/three/') ? 'three' : undefined),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
