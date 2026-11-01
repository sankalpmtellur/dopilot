import { z } from 'zod';

/**
 * How much a tool can affect the user. `sensitive` tools always need explicit
 * confirmation, whatever the model or the page asks for.
 */
export const ToolRiskSchema = z.enum(['read', 'interact', 'sensitive']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const AgentRunStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_confirmation',
  'cancelled',
  'limit_reached',
  'completed',
  'failed',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const ToolCallSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  arguments: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;
