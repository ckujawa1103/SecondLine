import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from the Worker at the domain root, so no base path — unlike Mint
// Voicemail, which sat under a GitHub Pages subdirectory.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // Local dev: proxy API calls to `wrangler dev` so the browser still sees a
  // single origin and WebAuthn keeps working.
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
    },
  },
});
