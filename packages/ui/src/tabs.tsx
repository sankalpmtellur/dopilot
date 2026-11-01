import type { TabInfo } from '@dopilot/shared';
import { ArrowLeft, ArrowRight, Globe, Lock, RotateCw, X } from 'lucide-react';
import { IconButton } from './button.js';

export function tabTitle(tab: TabInfo): string {
  if (tab.title) return tab.title;
  return tab.restricted ? 'Browser page' : `Tab ${tab.position}`;
}

function tabHost(tab: TabInfo): string | undefined {
  if (!tab.url) return undefined;
  try {
    return new URL(tab.url).host;
  } catch {
    return undefined;
  }
}

export interface TabListProps {
  tabs: TabInfo[];
  currentTabId?: number | null;
  onSwitch?: (tab: TabInfo) => void;
  onClose?: (tab: TabInfo) => void;
}

export function TabList({ tabs, currentTabId, onSwitch, onClose }: TabListProps) {
  if (tabs.length === 0) return <p className="text-[13px] text-muted">No open tabs found.</p>;

  return (
    <ul className="flex flex-col gap-0.5">
      {tabs.map((tab) => {
        const Icon = tab.restricted ? Lock : Globe;
        const host = tabHost(tab);
        const body = (
          <>
            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{tabTitle(tab)}</span>
              {host && <span className="block truncate text-xs text-faint">{host}</span>}
            </span>
            <span className="shrink-0 text-xs text-faint tabular-nums">{tab.position}</span>
          </>
        );

        return (
          <li
            key={tab.id}
            className={`group flex items-center gap-1 rounded-lg ${
              tab.id === currentTabId ? 'bg-raised' : 'hover:bg-raised'
            }`}
          >
            {onSwitch && !tab.restricted ? (
              <button
                type="button"
                onClick={() => onSwitch(tab)}
                aria-label={`Switch to ${tabTitle(tab)}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left"
              >
                {body}
              </button>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">{body}</div>
            )}
            {onClose && !tab.restricted && (
              <IconButton
                label={`Close ${tabTitle(tab)}`}
                onClick={() => onClose(tab)}
                className="size-7"
              >
                <X aria-hidden="true" className="size-3.5" />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface CurrentTabProps {
  tab: TabInfo | undefined;
  /** What to say when there is no tab to show. */
  emptyLabel: string;
  disabled?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
}

export function CurrentTab({
  tab,
  emptyLabel,
  disabled = false,
  onBack,
  onForward,
  onReload,
}: CurrentTabProps) {
  const unavailable = disabled || !tab || tab.restricted;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="min-w-0 flex-1 pr-1">
        {tab ? (
          <>
            <p className="truncate text-[13px] font-medium">{tabTitle(tab)}</p>
            <p className="truncate text-xs text-faint">
              {tab.restricted ? 'Internal page' : (tabHost(tab) ?? 'Details off')}
            </p>
          </>
        ) : (
          <p className="truncate text-[13px] text-muted">{emptyLabel}</p>
        )}
      </div>
      {onBack && (
        <IconButton label="Go back" onClick={onBack} disabled={unavailable} className="size-7">
          <ArrowLeft aria-hidden="true" className="size-3.5" />
        </IconButton>
      )}
      {onForward && (
        <IconButton
          label="Go forward"
          onClick={onForward}
          disabled={unavailable}
          className="size-7"
        >
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </IconButton>
      )}
      {onReload && (
        <IconButton label="Reload" onClick={onReload} disabled={unavailable} className="size-7">
          <RotateCw aria-hidden="true" className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}
