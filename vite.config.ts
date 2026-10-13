import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The build id the browser puts on error reports (src/telemetry.ts), matching
// the server's (releaseOf in server/log.ts): RELEASE if set, else the commit
// Vercel or GitHub Actions is building, else "dev".
const release = process.env.RELEASE?.trim() || (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '').trim().slice(0, 12) || 'dev';

export default defineConfig({
  define: { 'import.meta.env.VITE_RELEASE': JSON.stringify(release) },
  server: {
    // `npm run dev:server` serves live metrics on 8787; the client falls back to demo mode without it.
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    // three.js is most of the bundle and changes far less often than the game:
    // its own chunk stays cached across our releases.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // The game, and the internal admin console (admin.html, src/admin/).
      // showcase.html stays a dev-only page.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
      output: {
        manualChunks: (id) => (id.includes('node_modules/three/') ? 'three' : undefined),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
