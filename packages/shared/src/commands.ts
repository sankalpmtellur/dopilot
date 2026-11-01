import { z } from 'zod';
import { MAX_URL_LENGTH } from './url-policy.js';

export const TabTargetSchema = z.union([
  z.strictObject({ tabId: z.number().int().nonnegative() }),
  /** 1-based position in the tab list. */
  z.strictObject({ position: z.number().int().min(1).max(10000) }),
]);
export type TabTarget = z.infer<typeof TabTargetSchema>;

/**
 * The closed list of browser actions. Nothing outside it can be requested, so a
 * website cannot reach arbitrary extension APIs. A missing target means the current tab.
 */
export const BrowserCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('tab.new') }),
  z.strictObject({ action: z.literal('tab.open_url'), url: z.string().min(1).max(MAX_URL_LENGTH) }),
  z.strictObject({ action: z.literal('tab.list') }),
  z.strictObject({ action: z.literal('tab.switch'), target: TabTargetSchema }),
  z.strictObject({ action: z.literal('tab.reload'), target: TabTargetSchema.optional() }),
  z.strictObject({ action: z.literal('tab.back'), target: TabTargetSchema.optional() }),
  z.strictObject({ action: z.literal('tab.forward'), target: TabTargetSchema.optional() }),
  z.strictObject({ action: z.literal('tab.close'), target: TabTargetSchema.optional() }),
]);
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

export const TabInfoSchema = z.strictObject({
  id: z.number().int().nonnegative(),
  position: z.number().int().min(1),
  active: z.boolean(),
  /** Title and URL are only available once the user has allowed tab details. */
  title: z.string().optional(),
  /** Never includes a query string or fragment. */
  url: z.string().optional(),
  restricted: z.boolean(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const CommandErrorCodeSchema = z.enum([
  'invalid_command',
  'blocked_url',
  'restricted_page',
  'tab_not_found',
  'no_target_tab',
  'no_history',
  'confirmation_required',
  'confirmation_denied',
  'confirmation_timeout',
  'confirmation_busy',
  'rate_limited',
  'duplicate_request',
  'execution_failed',
  'extension_unavailable',
  'timeout',
  'cancelled',
]);
export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>;

export const CommandResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    message: z.string(),
    tab: TabInfoSchema.optional(),
    tabs: z.array(TabInfoSchema).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: CommandErrorCodeSchema,
    message: z.string(),
  }),
]);
export type CommandResult = z.infer<typeof CommandResultSchema>;

export function commandError(code: CommandErrorCode, message: string): CommandResult {
  return { ok: false, code, message };
}

export const CommandSourceSchema = z.enum(['panel', 'website']);
export type CommandSource = z.infer<typeof CommandSourceSchema>;

export const ActionLogEntrySchema = z.strictObject({
  id: z.string().min(1),
  at: z.number(),
  source: CommandSourceSchema,
  summary: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type ActionLogEntry = z.infer<typeof ActionLogEntrySchema>;

function describeTarget(target?: TabTarget): string {
  if (!target) return 'current tab';
  return 'position' in target ? `tab ${target.position}` : 'selected tab';
}

/** A short label for logs. Query strings stay out, since they often contain tokens. */
export function describeCommand(command: BrowserCommand): string {
  switch (command.action) {
    case 'tab.new':
      return 'Open a new tab';
    case 'tab.open_url':
      return `Open ${command.url.split(/[?#]/, 1)[0]}`;
    case 'tab.list':
      return 'List tabs';
    case 'tab.switch':
      return `Switch to ${describeTarget(command.target)}`;
    case 'tab.reload':
      return `Reload ${describeTarget(command.target)}`;
    case 'tab.back':
      return `Go back in ${describeTarget(command.target)}`;
    case 'tab.forward':
      return `Go forward in ${describeTarget(command.target)}`;
    case 'tab.close':
      return `Close ${describeTarget(command.target)}`;
  }
}
