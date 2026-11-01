import { describeGroqConnection } from '@dopilot/shared';
import type { GroqStatus } from '@dopilot/shared';
import { Button, groqShortLabel, groqTone, StatusPill, ThemeSwitch } from '@dopilot/ui';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { loadGroqStatus, removeApiKey, saveApiKey, selectModel } from '@/lib/api-key-store';
import { testGroqConnection } from '@/lib/panel-client';
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
          Text model
        </label>
        <select
          id="groq-model"
          value={status.selectedModel ?? ''}
          disabled={status.models.length === 0}
          onChange={(event) => {
            void selectModel(event.target.value || null).then(refresh);
          }}
          className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm outline-none focus:border-faint disabled:opacity-50"
        >
          <option value="">
            {status.models.length === 0 ? 'Test the connection to load models' : 'Choose a model'}
          </option>
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
          : 'Off. Tab commands still work, but tabs appear by number. Turning this on lets Dopilot see the titles and addresses of open tabs, and your browser will describe it as reading your browsing history.'}
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
      <TabDetailsSection />
      <Section title="Appearance">
        <div>
          <ThemeSwitch />
        </div>
      </Section>
    </div>
  );
}
