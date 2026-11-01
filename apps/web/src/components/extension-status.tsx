'use client';

import { useExtensionConnection } from '@/hooks/use-extension-connection';

export function ExtensionStatus() {
  const connection = useExtensionConnection();

  let label = 'Checking for the extension…';
  if (connection?.state === 'connected') label = `Extension connected (v${connection.version})`;
  if (connection?.state === 'not_detected') label = 'Extension not detected';
  if (connection?.state === 'not_configured') label = 'Extension ID not configured';

  return (
    <p role="status" data-testid="extension-status" className="text-sm text-zinc-500">
      {label}
    </p>
  );
}
