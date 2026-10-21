import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { serviceWorker } from './vite-pwa.ts';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3210', changeOrigin: true, timeout: 600000 } },
  },
});
