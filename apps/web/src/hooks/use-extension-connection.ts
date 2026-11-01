'use client';

import { useEffect, useState } from 'react';
import { connectToExtension } from '@/lib/extension-bridge';
import type { ExtensionConnection } from '@/lib/extension-bridge';

export function useExtensionConnection(): ExtensionConnection | null {
  const [connection, setConnection] = useState<ExtensionConnection | null>(null);

  useEffect(() => {
    let active = true;
    void connectToExtension(process.env.NEXT_PUBLIC_DOPILOT_EXTENSION_ID || undefined).then(
      (result) => {
        if (active) setConnection(result);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return connection;
}
