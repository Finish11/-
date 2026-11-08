import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Версия интерфейса берётся из package.json — того же места, что версия APK и релиза.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
