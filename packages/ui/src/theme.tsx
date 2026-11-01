import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useState } from 'react';
import { THEME_STORAGE_KEY } from './theme-script.js';

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = THEME_STORAGE_KEY;

function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice = readTheme()): void {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeChoice>(() =>
    typeof window === 'undefined' ? 'system' : readTheme(),
  );

  const setTheme = useCallback((choice: ThemeChoice) => {
    setThemeState(choice);
    applyTheme(choice);
    try {
      if (choice === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // The choice still applies until the page reloads.
    }
  }, []);

  return { theme, setTheme };
}

const OPTIONS = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const;

export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-lg border border-line bg-raised p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => setTheme(value)}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition duration-150 ${
            theme === value ? 'bg-surface text-ink shadow-xs' : 'text-muted hover:text-ink'
          }`}
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
