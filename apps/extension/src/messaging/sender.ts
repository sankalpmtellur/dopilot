/**
 * True only for this extension's own pages. Content scripts share the extension's
 * ID but report the origin of the webpage they run in, so the ID alone is not enough.
 */
export function isExtensionPage(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'origin'>,
  extensionId: string,
): boolean {
  return sender.id === extensionId && sender.origin === `chrome-extension://${extensionId}`;
}
