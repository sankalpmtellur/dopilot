import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

const workspaceRoot = resolve(import.meta.dirname, '../..');

// The monorepo keeps one .env at its root; Next.js only looks in the app folder.
const rootEnv = resolve(workspaceRoot, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
};

export default nextConfig;
