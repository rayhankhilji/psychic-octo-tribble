import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    // `npm run dev:server` serves live metrics on 8787; the client falls back to demo mode without it.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    chunkSizeWarningLimit: 1000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
