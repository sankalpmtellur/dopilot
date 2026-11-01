import { applyTheme, Brand, Button, ScreenshotPreview } from '@dopilot/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentApproval } from '@dopilot/shared';
import {
  answerApproval,
  decideConfirmation,
  getApproval,
  getConfirmationPrompt,
  getScreenshotPreview,
} from '@/lib/panel-client';
import '@/styles/app.css';

applyTheme();

const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const approvalId = params.get('approval');

/** Approvals for agent tasks, when the side panel is closed. */
function ApprovalPage({ approvalId }: { approvalId: string }) {
  const [approval, setApproval] = useState<AgentApproval | null | undefined>(undefined);

  useEffect(() => {
    getApproval(approvalId)
      .then(setApproval)
      .catch(() => setApproval(null));
  }, [approvalId]);

  if (approval === undefined) return null;
  if (approval === null) {
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
          {approval.title}
        </p>
        <p className="mt-1 text-[13px] text-muted">{approval.detail}</p>
        {approval.screenshotId && (
          <ScreenshotPreview id={approval.screenshotId} load={getScreenshotPreview} />
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void answerApproval(approval, false)}>Decline</Button>
        <Button variant="primary" onClick={() => void answerApproval(approval, true)}>
          Allow
        </Button>
      </div>
    </>
  );
}

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
      {approvalId ? <ApprovalPage approvalId={approvalId} /> : <ConfirmPage />}
    </main>
  </StrictMode>,
);
