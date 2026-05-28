import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config. The dev-server proxy forwards /api and /ws to the backend
// (running on :4000), so the browser only ever talks to :5173 -- same-origin,
// no CORS friction. Production builds serve from a static host that points
// at the same backend (proxy or reverse proxy in front, not configured here).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
