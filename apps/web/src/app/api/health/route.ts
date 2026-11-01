import type { HealthResponse } from '@dopilot/shared';

export const dynamic = 'force-dynamic';

export function GET() {
  const body: HealthResponse = {
    status: 'ok',
    service: 'web',
    version: '0.1.0',
    uptimeSeconds: process.uptime(),
  };
  return Response.json(body);
}
