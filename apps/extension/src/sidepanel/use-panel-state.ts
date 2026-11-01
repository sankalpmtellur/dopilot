import type { ExtensionState } from '@dopilot/shared';
import { useCallback, useEffect, useState } from 'react';
import { getState } from '@/lib/panel-client';

export const CONVERSATION_STORAGE_KEY = 'panelConversation';

/** The worker owns all state. This view re-reads it whenever the browser reports a change. */
export function usePanelState() {
  const [state, setState] = useState<ExtensionState | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await getState());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const onChange = () => void refresh();
    const onStorage = (changes: Record<string, unknown>) => {
      if (!(CONVERSATION_STORAGE_KEY in changes)) void refresh();
    };

    const events = [
      chrome.tabs.onActivated,
      chrome.tabs.onCreated,
      chrome.tabs.onRemoved,
      chrome.tabs.onUpdated,
      chrome.tabs.onMoved,
      chrome.windows.onFocusChanged,
      chrome.permissions.onAdded,
      chrome.permissions.onRemoved,
    ] as chrome.events.Event<() => void>[];

    for (const event of events) event.addListener(onChange);
    chrome.storage.onChanged.addListener(onStorage);
    onChange();

    return () => {
      for (const event of events) event.removeListener(onChange);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, [refresh]);

  return { state, failed, refresh };
}
