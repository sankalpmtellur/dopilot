import { HealthResponseSchema } from '@dopilot/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const WEB_ORIGIN = 'http://localhost:3000';

describe('backend', async () => {
  const app = await buildApp({ LOG_LEVEL: 'silent', WEB_ORIGIN });
  afterAll(() => app.close());

  it('reports health in the shared schema', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.safeParse(response.json()).success).toBe(true);
  });

  it('only allows the configured web origin through CORS', async () => {
    const headers = (origin: string) =>
      app.inject({ method: 'GET', url: '/health', headers: { origin } });
    const allowed = await headers(WEB_ORIGIN);
    const blocked = await headers('https://evil.example');
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('applies defaults and rejects invalid env', () => {
    expect(loadEnv({}).BACKEND_PORT).toBe(4000);
    expect(() => loadEnv({ BACKEND_PORT: 'nope' })).toThrow();
  });
});
