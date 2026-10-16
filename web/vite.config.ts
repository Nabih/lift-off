import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the UI on :5173 and proxies the API to the Express
// server on :4000. In production the Express server serves web/dist directly,
// so this proxy is a development convenience only.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
