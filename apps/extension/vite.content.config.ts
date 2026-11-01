import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const src = resolve(import.meta.dirname, 'src');

// Content scripts cannot use ES module imports, so this one builds as a single IIFE.
export default defineConfig(({ mode }) => ({
  publicDir: false,
  resolve: { alias: { '@': src } },
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: false,
    sourcemap: mode !== 'production',
    lib: {
      entry: resolve(src, 'content/index.ts'),
      formats: ['iife'],
      name: 'dopilotContent',
      fileName: () => 'content.js',
    },
  },
}));
