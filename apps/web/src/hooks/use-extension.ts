'use client';

import { isAgentActive } from '@dopilot/shared';
import type { ExtensionState } from '@dopilot/shared';
import { useCallback, useEffect, useState } from 'react';
import { fetchExtensionState, getExtensionId } from '@/lib/extension-bridge';

const POLL_INTERVAL_MS = 4000;
const ACTIVE_POLL_INTERVAL_MS = 800;

export type ExtensionConnection =
  | { status: 'checking' }
  | { status: 'unavailable' }
  | { status: 'connected'; state: ExtensionState };

/**
 * The extension can be installed, removed or reloaded at any moment, so this keeps
 * checking while the page is visible and reports only what the last check found.
 */
export function useExtension() {
  const [connection, setConnection] = useState<ExtensionConnection>({ status: 'checking' });
  const extensionId = getExtensionId();

  const refresh = useCallback(async () => {
    const state = await fetchExtensionState(extensionId);
    setConnection(state ? { status: 'connected', state } : { status: 'unavailable' });
  }, [extensionId]);

  const running =
    connection.status === 'connected' &&
    connection.state.agent !== null &&
    isAgentActive(connection.state.agent.status);
  const interval = running ? ACTIVE_POLL_INTERVAL_MS : POLL_INTERVAL_MS;

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    tick();
    const timer = setInterval(tick, interval);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, interval]);

  return { connection, refresh, extensionId };
}
