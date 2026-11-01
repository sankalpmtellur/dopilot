import type { HealthResponse } from '@dopilot/shared';

const VERSION = '0.1.0';

export function getHealth(): HealthResponse {
  return {
    status: 'ok',
    service: 'backend',
    version: VERSION,
    uptimeSeconds: process.uptime(),
  };
}
