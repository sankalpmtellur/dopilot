import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = resolve(import.meta.dirname, 'src');

export default defineConfig(({ mode }) => ({
  root: src,
  publicDir: resolve(import.meta.dirname, 'public'),
  base: '',
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { alias: { '@': src } },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    // Watch mode must not delete the separately built content script.
    emptyOutDir: mode === 'production',
    modulePreload: false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: {
        sidepanel: resolve(src, 'sidepanel/index.html'),
        settings: resolve(src, 'settings/index.html'),
        confirm: resolve(src, 'confirm/index.html'),
        background: resolve(src, 'background/index.ts'),
      },
      output: { entryFileNames: '[name].js' },
    },
  },
}));
