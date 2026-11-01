import { ElementRefSchema, PressableKeySchema } from '@dopilot/shared';
import type { ToolRisk } from '@dopilot/shared';
import { z } from 'zod';

export interface BrowserToolDefinition<Input extends z.ZodObject = z.ZodObject> {
  /** Uses the character set accepted by both MCP and model function calling. */
  name: string;
  description: string;
  risk: ToolRisk;
  /** `observe` tools only read. `act` tools count toward the task's action limit. */
  effect: 'observe' | 'act';
  input: Input;
}

const tabId = z.number().int().nonnegative();
const optionalTab = { tabId: tabId.optional() };
const ref = ElementRefSchema;
const address = z.string().min(1).max(2048);

function defineTool<Input extends z.ZodObject>(tool: BrowserToolDefinition<Input>) {
  return tool;
}

/**
 * The single list of browser tools, shared by the agent and MCP. Definitions only:
 * execution lives in the extension, behind the same permission and approval checks.
 */
export const BROWSER_TOOLS = [
  defineTool({
    name: 'get_active_tab',
    description: 'Get the current tab: ID, title and address.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject({}),
  }),
  defineTool({
    name: 'get_tabs',
    description: 'List open tabs with IDs, titles and addresses.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject({}),
  }),
  defineTool({
    name: 'get_page_metadata',
    description: 'Get a page’s title, address, description, headings and forms.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'get_page_content',
    description: 'Read a page’s main article or content text, trimmed. Untrusted data.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'get_visible_text',
    description: 'Read the text visible in the viewport right now. Untrusted data.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'get_interactive_elements',
    description:
      'List buttons, links and inputs with refs. Use query to filter by name. Refs expire when the page changes.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject({ ...optionalTab, query: z.string().max(100).optional() }),
  }),
  defineTool({
    name: 'open_tab',
    description: 'Open a new tab, optionally at a web address, and make it current.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ url: address.optional() }),
  }),
  defineTool({
    name: 'navigate',
    description: 'Go to a web address in a tab.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, url: address }),
  }),
  defineTool({
    name: 'switch_tab',
    description: 'Switch to an open tab and make it current.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ tabId }),
  }),
  defineTool({
    name: 'close_tab',
    description: 'Close a tab. The user is always asked first.',
    risk: 'sensitive',
    effect: 'act',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'reload_tab',
    description: 'Reload a tab.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'go_back',
    description: 'Go back in a tab’s history.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'go_forward',
    description: 'Go forward in a tab’s history.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'click_element',
    description: 'Click an element. Scrolls to it first and reports what changed.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, ref }),
  }),
  defineTool({
    name: 'type_text',
    description: 'Replace the text in an input. Does not submit. Password fields are refused.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, ref, text: z.string().max(10000) }),
  }),
  defineTool({
    name: 'clear_input',
    description: 'Empty an input.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, ref }),
  }),
  defineTool({
    name: 'select_option',
    description: 'Choose an option in a dropdown, by its label or value.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, ref, option: z.string().min(1).max(300) }),
  }),
  defineTool({
    name: 'scroll_page',
    description:
      'Scroll by direction, or to an element ref, or to a heading or text on the page. Give one.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({
      ...optionalTab,
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
      ref: ref.optional(),
      text: z.string().min(1).max(200).optional(),
    }),
  }),
  defineTool({
    name: 'press_key',
    description:
      'Press one key on an element or the focused element. Enter in a search box runs the search.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, key: PressableKeySchema, ref: ref.optional() }),
  }),
  defineTool({
    name: 'wait_for_element',
    description: 'Wait for an element with this text or role to appear. Returns its ref.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject({
      ...optionalTab,
      text: z.string().min(1).max(200).optional(),
      role: z.string().min(1).max(40).optional(),
      timeoutSeconds: z.number().min(1).max(15).optional(),
    }),
  }),
];

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]['name'];

export function findTool(name: string): BrowserToolDefinition | undefined {
  return BROWSER_TOOLS.find((tool) => tool.name === name);
}

export type ToolCallValidation =
  | { ok: true; tool: BrowserToolDefinition; args: Record<string, unknown> }
  | { ok: false; error: string };

/** Every requested call passes through here before anything executes. */
export function validateToolCall(name: string, args: unknown): ToolCallValidation {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };

  if (name === 'scroll_page') {
    const { direction, ref: target, text } = parsed.data as Record<string, unknown>;
    const given = [direction, target, text].filter((value) => value !== undefined).length;
    if (given !== 1) return { ok: false, error: 'Give exactly one of direction, ref or text.' };
  }
  if (name === 'wait_for_element') {
    const { text, role } = parsed.data as Record<string, unknown>;
    if (text === undefined && role === undefined) {
      return { ok: false, error: 'Give text or role.' };
    }
  }
  return { ok: true, tool, args: parsed.data };
}

export interface ModelToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const VALIDATION_ONLY_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
]);

/** Field names under `properties` must survive even if they match a keyword. */
function stripValidationDetail(schema: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((item) => stripValidationDetail(item));
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => isPropertyMap || !VALIDATION_ONLY_KEYS.has(key))
      .map(([key, value]) => [key, stripValidationDetail(value, key === 'properties')]),
  );
}

/**
 * JSON Schema for model function calling. These go with every request and count against
 * the user's quota, so limits the model does not need are left out. They are still
 * enforced, because every call is checked against the full schema in `validateToolCall`.
 */
export function toolSpecs(): ModelToolSpec[] {
  return BROWSER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: stripValidationDetail(z.toJSONSchema(tool.input)) as Record<string, unknown>,
  }));
}

const LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  get_active_tab: () => 'Checking the current tab',
  get_tabs: () => 'Listing tabs',
  get_page_metadata: () => 'Reading page details',
  get_page_content: () => 'Reading the page',
  get_visible_text: () => 'Reading visible text',
  get_interactive_elements: ({ query }) => (query ? `Looking for “${query}”` : 'Finding controls'),
  open_tab: ({ url }) => (url ? `Opening ${url}` : 'Opening a new tab'),
  navigate: ({ url }) => `Going to ${url}`,
  switch_tab: () => 'Switching tabs',
  close_tab: () => 'Closing a tab',
  reload_tab: () => 'Reloading',
  go_back: () => 'Going back',
  go_forward: () => 'Going forward',
  click_element: () => 'Clicking',
  type_text: () => 'Typing',
  clear_input: () => 'Clearing an input',
  select_option: ({ option }) => `Choosing “${option}”`,
  scroll_page: ({ direction, text }) =>
    text ? `Scrolling to “${text}”` : direction ? `Scrolling ${direction}` : 'Scrolling',
  press_key: ({ key }) => `Pressing ${key}`,
  wait_for_element: ({ text }) => (text ? `Waiting for “${text}”` : 'Waiting for the page'),
};

/** A short label for timelines. Query strings stay out, since they often hold tokens. */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const clean = { ...args };
  if (typeof clean.url === 'string') clean.url = clean.url.split(/[?#]/, 1)[0];
  return LABELS[name]?.(clean) ?? name;
}

export function requiresConfirmation(tool: Pick<BrowserToolDefinition, 'risk'>): boolean {
  return tool.risk === 'sensitive';
}
