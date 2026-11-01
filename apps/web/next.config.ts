import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = resolve(import.meta.dirname, '../..');

// The monorepo keeps one .env at its root; Next.js only looks in the app folder.
const rootEnv = resolve(workspaceRoot, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Inlined at build time, so a deployment without it would look fine and never connect.
if (
  process.env.VERCEL_ENV === 'production' &&
  !process.env.NEXT_PUBLIC_DOPILOT_EXTENSION_IDS?.trim()
) {
  throw new Error('Set NEXT_PUBLIC_DOPILOT_EXTENSION_IDS for production deployments.');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The console can start browser tasks, so no other site may frame it.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
        ],
      },
    ];
  },
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
};

export default nextConfig;
