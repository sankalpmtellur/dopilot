import { agentStatusLabel } from '@dopilot/shared';
import type { AgentApproval, AgentRunView, AgentTimelineEntry } from '@dopilot/shared';
import { Check, Circle, CircleSlash, Eye, Hand, Loader, OctagonX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './button.js';
import { StatusDot } from './status.js';
import type { StatusTone } from './status.js';

const ENTRY_ICONS = {
  running: <Loader aria-hidden="true" className="size-3.5 animate-spin text-muted" />,
  done: <Check aria-hidden="true" className="size-3.5 text-ok" />,
  failed: <X aria-hidden="true" className="size-3.5 text-danger" />,
  skipped: <CircleSlash aria-hidden="true" className="size-3.5 text-faint" />,
} as const;

const ENTRY_STATUS_TEXT = {
  running: 'In progress',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
} as const;

export function AgentTimeline({
  entries,
  pending = [],
}: {
  entries: AgentTimelineEntry[];
  /** Steps decided on but not started. */
  pending?: string[];
}) {
  if (entries.length === 0 && pending.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Steps">
      {entries.map((entry) => (
        <li key={entry.id} className="animate-fade flex gap-2">
          <span className="mt-0.5 shrink-0">
            {entry.kind === 'approval' && entry.status === 'running' ? (
              <Hand aria-hidden="true" className="size-3.5 text-accent" />
            ) : entry.kind === 'vision' && entry.status === 'running' ? (
              <Eye aria-hidden="true" className="size-3.5 animate-breathe text-accent" />
            ) : (
              ENTRY_ICONS[entry.status]
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] break-words">
              <span className="sr-only">{ENTRY_STATUS_TEXT[entry.status]}: </span>
              {entry.label}
            </p>
            {entry.detail && <p className="text-xs break-words text-faint">{entry.detail}</p>}
          </div>
        </li>
      ))}
      {pending.map((label, index) => (
        <li key={`${index}-${label}`} className="flex gap-2 text-faint">
          <span className="mt-0.5 shrink-0">
            <Circle aria-hidden="true" className="size-3.5" />
          </span>
          <p className="min-w-0 flex-1 text-[13px] break-words">
            <span className="sr-only">Pending: </span>
            {label}
          </p>
        </li>
      ))}
    </ol>
  );
}

/** Seconds so far, so a slow step looks like work and not like a freeze. */
function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.round((now - startedAt) / 1000));
}

function tokensUsed(run: AgentRunView): number {
  return (run.metrics?.promptTokens ?? 0) + (run.metrics?.completionTokens ?? 0);
}

function statusTone(run: AgentRunView): StatusTone {
  return run.status === 'waiting_for_approval' ? 'warn' : 'pending';
}

export interface AgentPanelProps {
  run: AgentRunView;
  onStop: () => void;
  /** Only extension pages pass this. The website cannot answer approvals. */
  onAnswerApproval?: (approval: AgentApproval, approved: boolean) => void;
  /** Only extension pages pass this. Screenshots never reach the website. */
  loadScreenshot?: (id: string) => Promise<string | null>;
}

/** Shows exactly what will be sent, with private fields already hidden. */
export function ScreenshotPreview({
  id,
  load,
}: {
  id: string;
  load: (id: string) => Promise<string | null>;
}) {
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void load(id).then((dataUrl) => {
      if (active) setImage(dataUrl);
    });
    return () => {
      active = false;
    };
  }, [id, load]);

  if (!image) return null;
  return (
    <img
      src={image}
      alt="The screenshot that would be sent"
      className="animate-fade mt-2 max-h-36 w-full rounded-md border border-line object-contain"
    />
  );
}

/** The live view of a running task, with its emergency stop always in reach. */
export function AgentPanel({ run, onStop, onAnswerApproval, loadScreenshot }: AgentPanelProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const count = run.timeline.length;
  const elapsed = useElapsedSeconds(run.startedAt);
  const looking = run.timeline.some(
    (entry) => entry.kind === 'vision' && entry.status === 'running',
  );

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count]);

  return (
    <section
      aria-label="Current task"
      className="animate-rise flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto rounded-xl border border-line bg-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          <StatusDot tone={statusTone(run)} />
          {agentStatusLabel(run.status)}
          <span className="font-normal text-faint">
            {elapsed}s · {run.actionCount} of {run.maxActions} actions
            {run.tabsOpened ? ` · ${run.tabsOpened} tabs opened` : ''}
          </span>
        </p>
        <Button variant="danger" aria-label="Stop task" onClick={onStop} className="shrink-0">
          <OctagonX aria-hidden="true" className="size-3.5" />
          Stop
        </Button>
      </div>

      <p className="text-[13px] break-words text-muted">{run.instruction}</p>

      {run.metrics && run.metrics.modelRequests > 0 && (
        <p className="text-xs text-faint">
          {run.metrics.modelRequests}
          {run.modelRequestLimit ? ` of ${run.modelRequestLimit}` : ''} AI requests
          {tokensUsed(run) > 0 &&
            ` · ${tokensUsed(run).toLocaleString('en')}${
              run.tokenLimit ? ` of ${run.tokenLimit.toLocaleString('en')}` : ''
            } tokens`}
        </p>
      )}

      {run.notice && (
        <p role="status" className="text-xs text-warn">
          {run.notice}
        </p>
      )}

      {looking && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-accent">
          <Eye aria-hidden="true" className="size-3.5" />
          Dopilot is looking at this page, using a screenshot.
        </p>
      )}

      {/* The prompt below says the same as its timeline entry, so the steps wait. */}
      {(count > 0 || Boolean(run.pendingSteps?.length)) && !run.approval && (
        <div ref={scroller} className="max-h-40 overflow-y-auto">
          <AgentTimeline entries={run.timeline} pending={run.pendingSteps ?? []} />
        </div>
      )}

      {run.approval && (
        <div
          role="alertdialog"
          aria-label="Approval needed"
          className="rounded-lg bg-accent-soft p-2.5"
        >
          <p className="text-sm font-medium break-words">{run.approval.title}</p>
          <p className="mt-0.5 text-xs break-words whitespace-pre-line text-muted">
            {run.approval.detail}
          </p>
          {run.approval.screenshotId && loadScreenshot && (
            <ScreenshotPreview id={run.approval.screenshotId} load={loadScreenshot} />
          )}
          {onAnswerApproval ? (
            <div className="mt-2 flex gap-2">
              <Button onClick={() => run.approval && onAnswerApproval(run.approval, false)}>
                Decline
              </Button>
              <Button
                variant="primary"
                onClick={() => run.approval && onAnswerApproval(run.approval, true)}
              >
                Allow
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-xs font-medium">
              Answer in the Dopilot side panel or window that opened.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
