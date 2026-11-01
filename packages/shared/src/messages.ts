import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const envelope = { protocolVersion: z.literal(PROTOCOL_VERSION) };

/**
 * Messages a web page may send to the extension. This is an untrusted boundary,
 * so the union stays small and must never carry privileged commands such as
 * "run this task" or "click this" without user confirmation in the extension.
 */
export const ExternalRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('external.ping') }),
]);
export type ExternalRequest = z.infer<typeof ExternalRequestSchema>;

export const ExternalResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope,
    type: z.literal('external.pong'),
    extensionVersion: z.string().min(1),
  }),
  z.strictObject({
    ...envelope,
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

/** Messages from the side panel to the service worker. */
export const PanelRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...envelope, type: z.literal('panel.get_status') }),
  z.strictObject({ ...envelope, type: z.literal('panel.stop_agent') }),
]);
export type PanelRequest = z.infer<typeof PanelRequestSchema>;

export const PanelResponseSchema = z.strictObject({
  ...envelope,
  type: z.literal('panel.status'),
  hasApiKey: z.boolean(),
  agentStatus: z.enum(['idle', 'cancelled']),
});
export type PanelResponse = z.infer<typeof PanelResponseSchema>;
