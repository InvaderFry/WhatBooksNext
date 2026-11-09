import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the Vite server proxies /api to the app. The proxy forwards the browser's
// Host and Origin (localhost:5173), which the server accepts only when started with WBN_DEV=1
// (PLAN.md §6.3).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:4818', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
