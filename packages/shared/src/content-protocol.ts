import { z } from 'zod';

/** Tied to one loaded document, so a reference can never point at a later page's element. */
export const ElementRefSchema = z.string().regex(/^[a-z0-9]{1,12}\.\d{1,7}$/);

export const PRESSABLE_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;
export const PressableKeySchema = z.enum(PRESSABLE_KEYS);
export type PressableKey = z.infer<typeof PressableKeySchema>;

const text = z.string().max(300);

/** Everything the service worker can ask of a page. There is no way to send code. */
export const ContentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('content.ping') }),
  z.strictObject({ type: z.literal('content.viewport') }),
  z.strictObject({
    type: z.literal('content.visual_snapshot'),
    limit: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal('content.ground_point'), x: z.number(), y: z.number() }),
  z.strictObject({
    type: z.literal('content.click_point'),
    ref: ElementRefSchema,
    x: z.number(),
    y: z.number(),
  }),
  z.strictObject({ type: z.literal('content.metadata') }),
  z.strictObject({
    type: z.literal('content.page_content'),
    maxChars: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('content.visible_text'),
    maxChars: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('content.interactive'),
    limit: z.number().int().positive(),
    query: text.optional(),
  }),
  z.strictObject({ type: z.literal('content.describe'), ref: ElementRefSchema.optional() }),
  z.strictObject({ type: z.literal('content.click'), ref: ElementRefSchema }),
  z.strictObject({
    type: z.literal('content.type'),
    ref: ElementRefSchema,
    text: z.string().max(10000),
  }),
  z.strictObject({ type: z.literal('content.clear'), ref: ElementRefSchema }),
  z.strictObject({ type: z.literal('content.select'), ref: ElementRefSchema, option: text }),
  z.strictObject({
    type: z.literal('content.scroll'),
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
    ref: ElementRefSchema.optional(),
    text: text.optional(),
  }),
  z.strictObject({
    type: z.literal('content.press'),
    key: PressableKeySchema,
    ref: ElementRefSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('content.wait'),
    text: text.optional(),
    role: z.string().max(40).optional(),
    timeoutMs: z.number().int().positive().max(15000),
  }),
]);
export type ContentRequest = z.infer<typeof ContentRequestSchema>;

/** Page facts the safety policy needs. Collected by code, never reported by the model. */
export const ElementFactsSchema = z.strictObject({
  tag: z.string(),
  role: z.string(),
  name: z.string(),
  inputType: z.string().nullable(),
  href: z.string().nullable(),
  isSubmit: z.boolean(),
  inForm: z.boolean(),
  /** GET forms marked as search, with no password field. */
  isSearchForm: z.boolean(),
  isFileInput: z.boolean(),
  /** Password, card, one-time code and similar fields. */
  isSecretField: z.boolean(),
  isChallenge: z.boolean(),
  /** Inside a dialog or modal, where a button usually answers a question. */
  inDialog: z.boolean().optional(),
  /** What that dialog says, because "OK" means nothing without it. */
  dialogText: z.string().optional(),
  /** Its form has password or payment fields, whatever the button is called. */
  formHasSecret: z.boolean().optional(),
  /** Attributes that may say what an unlabelled control does. Only used to ask more often. */
  hints: z.string().optional(),
});
export type ElementFacts = z.infer<typeof ElementFactsSchema>;

export const PageFactsSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  hasChallenge: z.boolean(),
});
export type PageFacts = z.infer<typeof PageFactsSchema>;

export const DescribeResultSchema = z.strictObject({
  element: ElementFactsSchema.nullable(),
  page: PageFactsSchema,
});
export type DescribeResult = z.infer<typeof DescribeResultSchema>;

const PATTERNS: [RegExp, string][] = [
  [/\b(?:\d[ -]?){13,19}\b/g, '[number removed]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[token removed]'],
  [/\b(?:gsk|sk|ghp|gho|xox[abp])[_-][A-Za-z0-9_-]{16,}/g, '[token removed]'],
  [/\b(?:bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '[token removed]'],
];

/** Page text goes to an AI provider, so obvious card numbers and tokens are removed first. */
export function redactSecrets(value: string): string {
  return PATTERNS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), value);
}
