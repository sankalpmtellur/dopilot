import { PanelResponseSchema, PROTOCOL_VERSION } from '@dopilot/shared';
import type { PanelRequest, PanelResponse } from '@dopilot/shared';
import { useEffect, useState } from 'react';

async function requestStatus(): Promise<PanelResponse> {
  const request: PanelRequest = { protocolVersion: PROTOCOL_VERSION, type: 'panel.get_status' };
  return PanelResponseSchema.parse(await chrome.runtime.sendMessage(request));
}

export function App() {
  const [status, setStatus] = useState<PanelResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    requestStatus()
      .then(setStatus)
      .catch(() => setFailed(true));
  }, []);

  let label = 'Connecting…';
  if (failed) label = 'Could not reach the background worker.';
  if (status) label = status.hasApiKey ? 'Groq API key saved.' : 'No Groq API key saved yet.';

  return (
    <main>
      <h1>Dopilot</h1>
      <p role="status">{label}</p>
    </main>
  );
}
