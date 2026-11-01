import { z } from 'zod';

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.enum(['web', 'backend']),
  version: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
