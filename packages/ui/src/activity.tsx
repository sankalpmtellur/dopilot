import type { ActionLogEntry } from '@dopilot/shared';
import { StatusDot } from './status.js';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const VIA_LABELS = { command: 'Command', instruction: 'No AI', ai: 'AI' } as const;

export function ActionList({ actions }: { actions: ActionLogEntry[] }) {
  if (actions.length === 0) {
    return <p className="text-[13px] text-muted">No browser actions yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-2.5">
      {actions.map((action) => (
        <li key={action.id} className="animate-fade flex gap-2">
          <span className="mt-1.5">
            <StatusDot tone={action.ok ? 'ok' : 'danger'} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] break-words">{action.summary}</p>
            {action.detail && action.detail !== action.summary && (
              <p className="text-xs break-words text-muted">{action.detail}</p>
            )}
            <p className="text-xs text-faint">
              {action.source === 'website' ? 'Website' : 'Side panel'}
              {action.via && ` · ${VIA_LABELS[action.via]}`} · {formatTime(action.at)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
