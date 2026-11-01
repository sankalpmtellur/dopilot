import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { buildManifest, resolveBuildConfig } from './build-config.ts';

const src = resolve(import.meta.dirname, 'src');
const buildConfig = resolveBuildConfig(process.env);

export default defineConfig(({ mode }) => ({
  root: src,
  publicDir: resolve(import.meta.dirname, 'public'),
  base: '',
  define: {
    __DOPILOT_WEB_ORIGINS__: JSON.stringify(buildConfig.webOrigins),
    __DOPILOT_MCP__: JSON.stringify(buildConfig.mcp),
  },
  plugins: [
    react(),
    {
      name: 'dopilot-manifest',
      closeBundle() {
        const path = resolve(import.meta.dirname, 'dist/manifest.json');
        const base = JSON.parse(
          readFileSync(resolve(import.meta.dirname, 'public/manifest.json'), 'utf8'),
        );
        writeFileSync(path, `${JSON.stringify(buildManifest(base, buildConfig), null, 2)}\n`);
      },
    },
  ],
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
