const OPEN = '<untrusted_page_content>';
const CLOSE = '</untrusted_page_content>';

/**
 * Marks webpage text as data before it reaches a model. Tags inside the text are
 * defused so a page cannot close the block early and pose as instructions.
 *
 * This reduces prompt injection but cannot prevent it. The real protections are
 * tool validation, permission checks and user approval for sensitive actions, all
 * of which are enforced by code the model cannot influence.
 */
export function wrapUntrustedContent(text: string): string {
  const defused = text.replace(/<(\/?)\s*untrusted_page_content/gi, '&lt;$1untrusted_page_content');
  return `${OPEN}\n${defused}\n${CLOSE}`;
}
