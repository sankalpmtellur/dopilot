import type { GroqStatus } from '@dopilot/shared';

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'pending';

const DOTS: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-faint',
  pending: 'bg-faint animate-breathe',
};

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOTS[tone]}`} />;
}

export function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span
      role="status"
      className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs whitespace-nowrap text-muted"
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

export function groqTone(status: GroqStatus): StatusTone {
  if (!status.configured) return 'neutral';
  switch (status.connection.state) {
    case 'connected':
      return 'ok';
    case 'untested':
      return 'neutral';
    case 'rate_limited':
    case 'network_error':
    case 'service_error':
      return 'warn';
    case 'invalid_key':
    case 'forbidden':
      return 'danger';
  }
}

export function groqShortLabel(status: GroqStatus): string {
  if (!status.configured) return 'No Groq key';
  switch (status.connection.state) {
    case 'connected':
      return 'Groq connected';
    case 'untested':
      return 'Groq untested';
    case 'rate_limited':
      return 'Groq rate limited';
    case 'network_error':
    case 'service_error':
      return 'Groq unreachable';
    case 'invalid_key':
    case 'forbidden':
      return 'Groq key rejected';
  }
}
