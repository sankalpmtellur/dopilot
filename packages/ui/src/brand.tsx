export function BrandMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="9" fill="var(--dp-primary)" />
      <path d="M10 8h6.5a8 8 0 0 1 0 16H10z" fill="var(--dp-on-primary)" />
      <circle cx="16.5" cy="16" r="2.6" fill="var(--dp-accent)" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className={compact ? 'size-5' : 'size-6'} />
      <span className={`font-semibold tracking-tight ${compact ? 'text-sm' : 'text-[15px]'}`}>
        Dopilot
      </span>
    </span>
  );
}
