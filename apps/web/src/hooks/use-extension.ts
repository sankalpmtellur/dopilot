'use client';

import { isAgentActive } from '@dopilot/shared';
import type { ExtensionState } from '@dopilot/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchExtensionState, findExtensionId, getExtensionId } from '@/lib/extension-bridge';

const POLL_INTERVAL_MS = 4000;
const ACTIVE_POLL_INTERVAL_MS = 800;
/** One missed reply is usually the worker waking up, not the extension being gone. */
const MISSES_BEFORE_UNAVAILABLE = 2;

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
  const [extensionId, setExtensionId] = useState(getExtensionId);
  const idRef = useRef(extensionId);
  const found = useRef(false);
  const latestRequest = useRef(0);
  const misses = useRef(0);
  const [recheck, setRecheck] = useState(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    if (!found.current) {
      const id = await findExtensionId();
      if (id) {
        found.current = true;
        idRef.current = id;
        setExtensionId(id);
      }
    }
    const state = await fetchExtensionState(idRef.current);
    // Replies can arrive out of order, and an older one must not undo a newer one.
    if (request !== latestRequest.current) return;
    if (state) {
      misses.current = 0;
      setConnection((previous) =>
        previous.status === 'connected' && JSON.stringify(previous.state) === JSON.stringify(state)
          ? previous
          : { status: 'connected', state },
      );
      return;
    }
    misses.current += 1;
    const gone = misses.current >= MISSES_BEFORE_UNAVAILABLE;
    if (gone) found.current = false;
    // A second look straight away, so a real disconnect shows in moments, not a poll later.
    else setRecheck((count) => count + 1);
    // Only a working connection is given the benefit of the doubt.
    setConnection((previous) =>
      previous.status === 'connected' && !gone ? previous : { status: 'unavailable' },
    );
  }, []);

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
  }, [refresh, interval, recheck]);

  return { connection, refresh, extensionId };
}
