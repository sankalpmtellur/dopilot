import type { ActionLogEntry } from '@dopilot/shared';
import { StatusDot } from './status.js';

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

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
            <p className="truncate text-[13px]">{action.summary}</p>
            <p className="text-xs break-words text-faint">
              {action.ok ? '' : `${action.detail} · `}
              {action.source === 'website' ? 'Website' : 'Side panel'} · {formatTime(action.at)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
