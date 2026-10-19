import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, '../dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, '../shared') } },
});
