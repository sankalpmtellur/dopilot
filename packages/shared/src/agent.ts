import { z } from 'zod';

/**
 * How much a tool can affect the user. `sensitive` tools always need explicit
 * approval, whatever the model or the page asks for.
 */
export const ToolRiskSchema = z.enum(['read', 'interact', 'sensitive']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const ToolCallSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  arguments: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** The result of any browser tool, whether the agent, a person or MCP called it. */
export const ToolResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    summary: z.string(),
    data: z.unknown().optional(),
    /** The page may be different now, so older element references should not be trusted. */
    pageChanged: z.boolean().optional(),
    /** The data came from a webpage, so it must be treated as data and never as instructions. */
    untrusted: z.boolean().optional(),
    /** Later tools without an explicit tab should act on this tab. */
    currentTabId: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    /** False when retrying the same thing cannot help. */
    recoverable: z.boolean(),
    /** Only the user can get past this, for example a CAPTCHA, so the task must end. */
    stopTask: z.boolean().optional(),
  }),
]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

export function toolFailure(
  code: string,
  message: string,
  recoverable = true,
  stopTask?: boolean,
): ToolResult {
  return { ok: false, code, message, recoverable, ...(stopTask && { stopTask }) };
}

export const AgentRunStatusSchema = z.enum([
  'thinking',
  'observing',
  'executing',
  'waiting_for_approval',
  'completed',
  'failed',
  'cancelled',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

const STATUS_LABELS: Record<AgentRunStatus, string> = {
  thinking: 'Thinking',
  observing: 'Observing',
  executing: 'Executing',
  waiting_for_approval: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function agentStatusLabel(status: AgentRunStatus): string {
  return STATUS_LABELS[status];
}

export function isAgentActive(status: AgentRunStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled';
}

export const AgentApprovalSchema = z.strictObject({
  id: z.string().min(1),
  /** `action` confirms one tool call. The others grant a browser permission first. */
  kind: z.enum(['action', 'site_access', 'tab_details', 'screenshot', 'screenshot_access']),
  title: z.string(),
  detail: z.string(),
  /** Exact origin to request, for `site_access`. */
  origin: z.string().optional(),
  /** The screenshot awaiting approval. Extension pages can show it. Websites cannot. */
  screenshotId: z.string().optional(),
});
export type AgentApproval = z.infer<typeof AgentApprovalSchema>;

export const AgentTimelineEntrySchema = z.strictObject({
  id: z.string().min(1),
  at: z.number(),
  kind: z.enum(['observe', 'vision', 'act', 'approval', 'retry', 'error']),
  status: z.enum(['running', 'done', 'failed', 'skipped']),
  label: z.string(),
  detail: z.string().optional(),
});
export type AgentTimelineEntry = z.infer<typeof AgentTimelineEntrySchema>;

export const AgentSourceSchema = z.enum(['panel', 'website']);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

/** What UIs may see of a run. It never includes the model conversation. */
export const AgentRunViewSchema = z.strictObject({
  id: z.string().min(1),
  instruction: z.string(),
  source: AgentSourceSchema,
  status: AgentRunStatusSchema,
  /** A temporary state worth showing, such as waiting out a rate limit. */
  notice: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  actionCount: z.number().int().nonnegative(),
  /** The answer may contain page content, so it should not be read aloud automatically. */
  readPageContent: z.boolean(),
  maxActions: z.number().int().positive(),
  timeline: z.array(AgentTimelineEntrySchema),
  approval: AgentApprovalSchema.nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
});
export type AgentRunView = z.infer<typeof AgentRunViewSchema>;

export const MAX_INSTRUCTION_LENGTH = 2000;
export const AgentInstructionSchema = z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH);
