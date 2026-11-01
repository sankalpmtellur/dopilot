import { describeGroqConnection } from '@dopilot/shared';
import type { GroqStatus } from '@dopilot/shared';
import { Button, groqShortLabel, groqTone, StatusPill, ThemeSwitch } from '@dopilot/ui';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { loadGroqStatus, removeApiKey, saveApiKey, selectModel } from '@/lib/api-key-store';
import { testGroqConnection } from '@/lib/panel-client';
import { MCP_BRIDGE_ORIGIN } from '@/lib/mcp-bridge';
import { configureMcp, getMcpStatus } from '@/lib/panel-client';
import { hasTabDetails, removeTabDetails, requestTabDetails } from '@/permissions/tab-details';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line pb-5 last:border-b-0">
      <h2 className="text-xs font-medium tracking-wide text-faint uppercase">{title}</h2>
      {children}
    </section>
  );
}

function GroqSection() {
  const [status, setStatus] = useState<GroqStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const refresh = useCallback(async () => setStatus(await loadGroqStatus()), []);

  useEffect(() => {
    void loadGroqStatus().then(setStatus);
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await saveApiKey(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The key stays out of component state from here on.
    setDraft('');
    setError(null);
    await refresh();
  }

  async function test() {
    setTesting(true);
    setError(null);
    try {
      setStatus(await testGroqConnection());
    } catch {
      setError('The test could not run. Try again.');
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    await removeApiKey();
    setConfirmingRemove(false);
    await refresh();
  }

  if (!status) return null;

  return (
    <Section title="Groq API key">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code data-testid="masked-key" className="text-[13px] text-muted">
          {status.maskedKey ?? 'No key saved'}
        </code>
        {status.configured && (
          <StatusPill
            tone={testing ? 'pending' : groqTone(status)}
            label={testing ? 'Testing…' : groqShortLabel(status)}
          />
        )}
      </div>
      {status.configured && (
        <p data-testid="groq-status" className="text-[13px] text-muted">
          {describeGroqConnection(status)}
        </p>
      )}

      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-2">
        <label htmlFor="groq-key" className="text-[13px]">
          {status.configured ? 'Replace key' : 'Your key'}
        </label>
        <input
          id="groq-key"
          type="password"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          placeholder="gsk_…"
          onChange={(event) => setDraft(event.target.value)}
          className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm outline-none focus:border-faint"
        />
        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={!draft}>
            Save
          </Button>
          <Button onClick={() => void test()} disabled={!status.configured || testing}>
            Test connection
          </Button>
          {status.configured &&
            (confirmingRemove ? (
              <>
                <Button variant="danger" onClick={() => void remove()}>
                  Confirm remove
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingRemove(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingRemove(true)}>
                Remove
              </Button>
            ))}
        </div>
      </form>

      <p className="text-xs leading-relaxed text-faint">
        Stored only in this browser profile and sent only to Groq. It isn’t encrypted, so use a key
        you can revoke.{' '}
        <a
          href="https://console.groq.com/keys"
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2 hover:text-ink"
        >
          Get a key
        </a>
      </p>

      <div className="flex flex-col gap-2">
        <label htmlFor="groq-model" className="text-[13px]">
          Model
        </label>
        <select
          id="groq-model"
          value={status.selectedModel ?? ''}
          onChange={(event) => {
            void selectModel(event.target.value || null).then(refresh);
          }}
          className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:border-faint disabled:opacity-50"
        >
          <option value="">Automatic (recommended)</option>
          {status.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id}
            </option>
          ))}
        </select>
      </div>
    </Section>
  );
}

const INTERNAL_HOSTS = ['https://api.groq.com/*', `${MCP_BRIDGE_ORIGIN}/*`];

function SiteAccessSection() {
  const [sites, setSites] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    const { origins = [] } = await chrome.permissions.getAll();
    setSites(origins.filter((origin) => !INTERNAL_HOSTS.includes(origin)));
  }, []);

  useEffect(() => {
    void chrome.permissions.getAll().then(({ origins = [] }) => {
      setSites(origins.filter((origin) => !INTERNAL_HOSTS.includes(origin)));
    });
  }, []);

  if (!sites) return null;

  return (
    <Section title="Sites Dopilot can use">
      {sites.length === 0 ? (
        <p className="text-[13px] text-muted">
          None yet. Dopilot asks the first time a task needs a site.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sites.map((site) => (
            <li key={site} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[13px]">{site.replace(/\/\*$/, '')}</span>
              <Button
                variant="ghost"
                aria-label={`Remove access to ${site.replace(/\/\*$/, '')}`}
                onClick={() => {
                  void chrome.permissions.remove({ origins: [site] }).then(refresh);
                }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function McpSection() {
  const [status, setStatus] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  const [token, setToken] = useState('');

  const refresh = useCallback(() => {
    void getMcpStatus()
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, connected: false }));
  }, []);

  useEffect(refresh, [refresh]);

  async function connect() {
    // Must be requested inside the click, and covers only the local bridge address.
    const granted = await chrome.permissions.request({ origins: [`${MCP_BRIDGE_ORIGIN}/*`] });
    if (!granted) return;
    await configureMcp(token.trim());
    setToken('');
    refresh();
  }

  if (!status) return null;

  return (
    <details className="group border-b border-line pb-5 last:border-b-0">
      <summary className="cursor-pointer list-none text-xs font-medium tracking-wide text-faint uppercase hover:text-ink [&::-webkit-details-marker]:hidden">
        Developer: local MCP bridge
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-[13px] text-muted">
          Lets a local MCP client use these browser tools, with the same permissions. Anything
          needing approval is refused. Lasts until the browser closes.
        </p>
        {status.enabled ? (
          <>
            <p data-testid="mcp-status" className="text-[13px]">
              {status.connected
                ? 'Connected to the local server.'
                : 'Waiting for the local server…'}
            </p>
            <div className="flex gap-2">
              <Button onClick={refresh}>Refresh</Button>
              <Button
                onClick={() => {
                  void configureMcp(null).then(refresh);
                }}
              >
                Turn off
              </Button>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="mcp-token" className="text-[13px]">
              Token printed by the server
            </label>
            <input
              id="mcp-token"
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setToken(event.target.value)}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm outline-none focus:border-faint"
            />
            <div>
              <Button disabled={!token.trim()} onClick={() => void connect()}>
                Connect
              </Button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function TabDetailsSection() {
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    void hasTabDetails().then(setGranted);
  }, []);

  return (
    <Section title="Tab details">
      <p className="text-[13px] leading-relaxed text-muted">
        {granted
          ? 'Dopilot can see the titles and addresses of your open tabs. Query strings are removed before they are shown.'
          : 'Off. Exact tab commands still work, but tabs appear by number. The agent will ask for this when it needs it, for example to find your GitHub tab. Your browser will describe it as reading your browsing history.'}
      </p>
      {granted !== null && (
        <div>
          {granted ? (
            <Button onClick={() => void removeTabDetails().then(() => setGranted(false))}>
              Turn off
            </Button>
          ) : (
            <Button onClick={() => void requestTabDetails().then(setGranted)}>
              Allow tab details
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

export function SettingsForm() {
  return (
    <div className="flex flex-col gap-5">
      <GroqSection />
      <SiteAccessSection />
      <TabDetailsSection />
      <Section title="Appearance">
        <div>
          <ThemeSwitch />
        </div>
      </Section>
      <McpSection />
    </div>
  );
}
