'use client';

import { useCallback, useSyncExternalStore } from 'react';

const subscribers = new Set<() => void>();

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/** A non-secret preference. API keys never go through here or any web storage. */
export function useStoredFlag(key: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => false,
  );

  const setValue = useCallback(
    (next: boolean) => {
      try {
        if (next) localStorage.setItem(key, 'true');
        else localStorage.removeItem(key);
      } catch {
        // Falls back to the default next time.
      }
      for (const callback of subscribers) callback();
    },
    [key],
  );

  return [value, setValue] as const;
}
