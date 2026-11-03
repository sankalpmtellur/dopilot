import type { GroqStatus } from '@dopilot/shared';
import type { ReactNode } from 'react';
import { GroqSection } from '@/settings/settings-form';

/** Real instructions, run the normal way. `ai` says whether one needs a Groq key. */
export const DEMO_PROMPTS = [
  {
    label: 'Organize tabs',
    prompt: 'Open YouTube, GitHub, and Wikipedia in separate tabs',
    ai: false,
  },
  {
    label: 'Move between sites',
    prompt:
      'Open Wikipedia and search for artificial intelligence, then scroll to the history section',
    ai: false,
  },
  { label: 'Ask first', prompt: 'Please open example.com/checkout', ai: false },
  { label: 'Summarize', prompt: 'Summarize this page', ai: true },
  {
    label: 'Several steps',
    prompt: 'Go to Wikipedia, find the article about Alan Turing, and tell me when he was born',
    ai: true,
  },
] as const;

const PERMISSIONS = [
  ['Sites', 'Dopilot asks the first time it needs to read or use a site. Remove any in settings.'],
  ['Tab names', 'Optional. Lets it find a tab by name. “Switch to tab 2” works without it.'],
  ['Screenshots', 'Optional. It shows you each image first, with private fields hidden.'],
  ['Microphone', 'Only while you hold the microphone button.'],
] as const;

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
      <h3 className="text-[13px] font-medium">{title}</h3>
      {children}
    </section>
  );
}

export function Welcome({
  groq,
  onRun,
}: {
  groq: GroqStatus | undefined;
  onRun: (prompt: string) => void;
}) {
  const hasKey = groq?.configured === true;
  const ready = groq?.connection.state === 'connected';

  return (
    <div className="animate-fade flex flex-col gap-3">
      <div className="px-1 pt-1">
        <h2 className="text-base font-semibold tracking-tight">Welcome to Dopilot</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Tell it what to do, in your own words. It opens tabs, reads pages, clicks and types in
          this browser. You see each step and can stop at any time, and it asks before anything
          sensitive. Nothing has been run yet.
        </p>
      </div>

      {groq && !ready && (
        <Card title={hasKey ? 'Test your Groq key' : 'Add your Groq key for AI tasks'}>
          <p className="text-xs leading-relaxed text-muted">
            Tab commands work without one. Reading pages and multi-step tasks use your own key.
          </p>
          <GroqSection compact />
        </Card>
      )}

      <Card title="Try one of these">
        <ul className="flex flex-col gap-1.5">
          {DEMO_PROMPTS.map(({ label, prompt, ai }) => {
            const blocked = ai && !hasKey;
            return (
              <li key={label}>
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => onRun(prompt)}
                  className="w-full rounded-lg border border-line px-2.5 py-1.5 text-left transition duration-150 hover:bg-raised disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className="flex items-center justify-between gap-2 text-xs font-medium">
                    {label}
                    <span className="font-normal text-faint">
                      {!ai ? 'No AI needed' : blocked ? 'Needs a key' : 'Uses AI'}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs break-words text-muted">{prompt}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {['Open a new tab', 'list tabs', 'help'].map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onRun(example)}
              className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition duration-150 hover:bg-raised hover:text-ink"
            >
              {example}
            </button>
          ))}
        </div>
      </Card>

      <details className="rounded-xl border border-line bg-surface px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium">
          What Dopilot asks permission for
        </summary>
        <dl className="mt-2 flex flex-col gap-1.5 text-xs">
          {PERMISSIONS.map(([name, why]) => (
            <div key={name}>
              <dt className="font-medium">{name}</dt>
              <dd className="text-muted">{why}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
