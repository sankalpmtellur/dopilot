import { AgentRunStatusSchema } from './agent.js';
import {
  ActionLogEntrySchema,
  BrowserCommandSchema,
  CommandResultSchema,
  TabInfoSchema,
} from './commands.js';
import { GroqStatusSchema } from './groq.js';
import { z } from 'zod';

export const PROTOCOL_VERSION = 2;

const envelope = { protocolVersion: z.literal(PROTOCOL_VERSION) };
const request = { ...envelope, requestId: z.uuid() };

export const ExtensionStateSchema = z.strictObject({
  extensionVersion: z.string().min(1),
  tabDetailsAvailable: z.boolean(),
  tabs: z.array(TabInfoSchema),
  /** For the website, this is the tab last used before the website itself. */
  currentTabId: z.number().int().nonnegative().nullable(),
  groq: GroqStatusSchema,
  agentStatus: AgentRunStatusSchema,
  recentActions: z.array(ActionLogEntrySchema),
});
export type ExtensionState = z.infer<typeof ExtensionStateSchema>;

/**
 * Everything a web page may ask of the extension. This is an untrusted boundary:
 * the union is closed, strict, and has no field that could carry an API key.
 */
export const ExternalRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...request, type: z.literal('external.ping') }),
  z.strictObject({ ...request, type: z.literal('external.get_state') }),
  z.strictObject({
    ...request,
    type: z.literal('external.command'),
    command: BrowserCommandSchema,
  }),
  z.strictObject({
    ...request,
    type: z.literal('external.cancel'),
    targetRequestId: z.uuid(),
  }),
  z.strictObject({ ...request, type: z.literal('external.open_settings') }),
]);
export type ExternalRequest = z.infer<typeof ExternalRequestSchema>;

const response = { ...envelope, requestId: z.string().nullable() };

export const ExternalResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...response,
    type: z.literal('external.pong'),
    extensionVersion: z.string().min(1),
  }),
  z.strictObject({ ...response, type: z.literal('external.state'), state: ExtensionStateSchema }),
  z.strictObject({
    ...response,
    type: z.literal('external.command_result'),
    result: CommandResultSchema,
  }),
  z.strictObject({ ...response, type: z.literal('external.ack') }),
  z.strictObject({
    ...response,
    type: z.literal('external.rejected'),
    reason: z.enum(['origin_not_allowed', 'invalid_message']),
  }),
]);
export type ExternalResponse = z.infer<typeof ExternalResponseSchema>;

/** Messages between the service worker and content scripts. */
export const ContentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('content.ping') }),
]);
export type ContentRequest = z.infer<typeof ContentRequestSchema>;

export const ContentResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('content.pong'), url: z.string() }),
]);
export type ContentResponse = z.infer<typeof ContentResponseSchema>;

/**
 * Messages from the extension's own pages to the service worker. Saving a key is
 * deliberately absent: pages write it straight to storage, so it is never in a message.
 */
export const PanelRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('panel.get_state') }),
  z.strictObject({
    ...envelope,
    type: z.literal('panel.execute'),
    command: BrowserCommandSchema,
    confirmed: z.boolean(),
  }),
  z.strictObject({ ...envelope, type: z.literal('panel.stop_agent') }),
  z.strictObject({ ...envelope, type: z.literal('panel.test_groq') }),
  z.strictObject({ ...envelope, type: z.literal('panel.get_confirmation'), id: z.uuid() }),
  z.strictObject({
    ...envelope,
    type: z.literal('panel.decide_confirmation'),
    id: z.uuid(),
    approved: z.boolean(),
  }),
]);
export type PanelRequest = z.infer<typeof PanelRequestSchema>;

export const PanelResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('panel.state'), state: ExtensionStateSchema }),
  z.strictObject({
    ...envelope,
    type: z.literal('panel.command_result'),
    result: CommandResultSchema,
  }),
  z.strictObject({ ...envelope, type: z.literal('panel.groq_status'), groq: GroqStatusSchema }),
  z.strictObject({
    ...envelope,
    type: z.literal('panel.confirmation'),
    prompt: z.string().nullable(),
  }),
  z.strictObject({ ...envelope, type: z.literal('panel.ack') }),
]);
export type PanelResponse = z.infer<typeof PanelResponseSchema>;
