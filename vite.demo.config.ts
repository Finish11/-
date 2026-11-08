import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Версия интерфейса берётся из package.json — того же места, что версия APK и релиза.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'demo-dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'demo.html'),
    },
  },
});
