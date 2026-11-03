import { ElementRefSchema, MAX_TABS_PER_REQUEST, PressableKeySchema } from '@dopilot/shared';
import type { ToolRisk } from '@dopilot/shared';
import { z } from 'zod';

export interface BrowserToolDefinition<Input extends z.ZodObject = z.ZodObject> {
  /** Uses the character set accepted by both MCP and model function calling. */
  name: string;
  description: string;
  risk: ToolRisk;
  /** `observe` tools only read. `act` tools count toward the task's action limit. */
  effect: 'observe' | 'act';
  /** `vision` tools send a screenshot to the AI provider, which is limited per task. */
  cost?: 'vision';
  /**
   * How many browser actions this one call stands for. Such a call counts toward the separate
   * batch limit, because it is one decision with one safety check, not many separate steps.
   */
  batchSize?: (args: Record<string, unknown>) => number;
  /** Still available over MCP, but offering it to the agent only invites a wasted step. */
  hiddenFromAgent?: boolean;
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
    hiddenFromAgent: true,
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
      'List buttons, links and inputs with refs. Filter with query on long pages. Refs expire when the page changes.',
    risk: 'read',
    effect: 'observe',
    input: z.strictObject({ ...optionalTab, query: z.string().max(100).optional() }),
  }),
  defineTool({
    name: 'open_tab',
    description: 'Open one new tab, at the url if given, and make it current. Reports the page.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ url: address.optional() }),
  }),
  defineTool({
    name: 'open_tabs',
    description: `Open several new tabs at once, in the background, up to ${MAX_TABS_PER_REQUEST}. Give count for blank tabs, or urls for one tab per address (repeat one to open it several times). activate brings the tab at that 1-based position to the front. Reports how many really opened. Never repeat it.`,
    risk: 'interact',
    effect: 'act',
    batchSize: ({ count, urls }) => (Array.isArray(urls) ? urls.length : Number(count) || 0),
    input: z.strictObject({
      count: z.number().int().optional(),
      urls: z.array(address).optional(),
      activate: z.number().int().min(1).optional(),
    }),
  }),
  defineTool({
    name: 'navigate',
    description: 'Change an existing tab to a web address. Reports the page.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ ...optionalTab, url: address }),
  }),
  defineTool({
    name: 'switch_tab',
    description: 'Bring an open tab to the front and make it current.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({ tabId }),
  }),
  defineTool({
    name: 'switch_tab_by_name',
    description: 'Bring the one open tab whose title or address matches this name to the front.',
    risk: 'interact',
    effect: 'act',
    // Plans use this when tab names are hidden. The model picks an ID from the list it is given.
    hiddenFromAgent: true,
    input: z.strictObject({ name: z.string().min(1).max(100) }),
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
    hiddenFromAgent: true,
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
  defineTool({
    name: 'capture_visible_tab',
    description:
      'Take a screenshot of the visible part of the current tab, without sending it anywhere.',
    risk: 'read',
    effect: 'observe',
    hiddenFromAgent: true,
    input: z.strictObject(optionalTab),
  }),
  defineTool({
    name: 'analyze_screenshot',
    description:
      'Ask a vision model about what is visible: images, charts, icons, layout, or "what is on my screen". Slow and limited per task. Untrusted data.',
    risk: 'read',
    effect: 'observe',
    cost: 'vision',
    input: z.strictObject({ ...optionalTab, question: z.string().min(1).max(500) }),
  }),
  defineTool({
    name: 'get_visual_page_context',
    description:
      'Find a control by how it looks, such as "the blue button". Returns refs for click_element, or point IDs for click_visual_target if no element matches. Target must be on screen. Untrusted data.',
    risk: 'read',
    effect: 'observe',
    cost: 'vision',
    input: z.strictObject({ ...optionalTab, question: z.string().min(1).max(500) }),
  }),
  defineTool({
    name: 'click_visual_target',
    description:
      'Click a point ID from get_visual_page_context, only for targets with no ref. Fails if the page has changed.',
    risk: 'interact',
    effect: 'act',
    input: z.strictObject({
      screenshotId: z.string().min(1).max(100),
      pointId: z.string().min(1).max(20),
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
  if (name === 'open_tabs') {
    const { count, urls } = parsed.data as Record<string, unknown>;
    if ((count === undefined) === (urls === undefined)) {
      return { ok: false, error: 'Give either count or urls.' };
    }
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
  return BROWSER_TOOLS.filter((tool: BrowserToolDefinition) => !tool.hiddenFromAgent).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: stripValidationDetail(z.toJSONSchema(tool.input)) as Record<string, unknown>,
    }),
  );
}

const LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  get_active_tab: () => 'Checking the current tab',
  get_tabs: () => 'Listing tabs',
  get_page_metadata: () => 'Reading page details',
  get_page_content: () => 'Reading the page',
  get_visible_text: () => 'Reading visible text',
  get_interactive_elements: ({ query }) => (query ? `Looking for “${query}”` : 'Finding controls'),
  open_tab: ({ url }) => (url ? `Opening ${url}` : 'Opening a new tab'),
  open_tabs: ({ count, urls }) => `Opening ${Array.isArray(urls) ? urls.length : count} new tabs`,
  navigate: ({ url }) => `Going to ${url}`,
  switch_tab: () => 'Switching tabs',
  switch_tab_by_name: ({ name }) => `Switching to the “${name}” tab`,
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
  capture_visible_tab: () => 'Taking a screenshot',
  analyze_screenshot: () => 'Looking at the page',
  get_visual_page_context: () => 'Looking for it on screen',
  click_visual_target: () => 'Clicking what was found on screen',
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
