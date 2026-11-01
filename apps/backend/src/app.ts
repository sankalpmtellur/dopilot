import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { Env } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { LOG_REDACT_PATHS } from './security/redaction.js';

export async function buildApp(env: Pick<Env, 'LOG_LEVEL' | 'WEB_ORIGIN'>) {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL, redact: LOG_REDACT_PATHS },
  });

  await app.register(cors, { origin: [env.WEB_ORIGIN] });
  await app.register(healthRoutes);

  return app;
}
