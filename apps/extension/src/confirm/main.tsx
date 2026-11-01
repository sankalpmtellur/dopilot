import { applyTheme, Brand, Button } from '@dopilot/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { decideConfirmation, getConfirmationPrompt } from '@/lib/panel-client';
import '@/styles/app.css';

applyTheme();

const id = new URLSearchParams(location.search).get('id') ?? '';

function ConfirmPage() {
  const [prompt, setPrompt] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getConfirmationPrompt(id)
      .then(setPrompt)
      .catch(() => setPrompt(null));
  }, []);

  if (prompt === undefined) return null;

  if (prompt === null) {
    return (
      <>
        <p className="text-sm text-muted">This request has expired.</p>
        <div>
          <Button onClick={() => window.close()}>Close</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        <p data-testid="confirm-prompt" className="text-[15px] font-medium break-words">
          {prompt}
        </p>
        <p className="mt-1 text-[13px] text-muted">Requested from the Dopilot website.</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void decideConfirmation(id, false)}>Keep open</Button>
        <Button variant="danger" onClick={() => void decideConfirmation(id, true)}>
          Close tab
        </Button>
      </div>
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <main className="flex min-h-screen flex-col justify-center gap-4 p-5">
      <Brand compact />
      <ConfirmPage />
    </main>
  </StrictMode>,
);
