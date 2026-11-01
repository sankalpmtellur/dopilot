import type { FastifyInstance } from 'fastify';
import { getHealth } from '../services/health.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => getHealth());
}
